import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { SubprocessReviewRunner } from './subprocess-runner';
import { ReviewResult, ReviewFinding, ReviewError } from './types';

/**
 * レビューループの各イテレーション記録
 */
export interface ReviewIteration {
  /** イテレーション番号（1始まり） */
  iteration: number;
  /** レビュー結果 */
  reviewResult: ReviewResult;
  /** 修正内容（修正が行われた場合） */
  fixDescription?: string;
  /** タイムスタンプ */
  timestamp: Date;
}

/**
 * レビューループの最終結果
 */
export interface ReviewLoopResult {
  /** 最終判定: OK=レビュー通過, NG=最大リトライ到達で未解決 */
  finalVerdict: 'OK' | 'NG';
  /** エスカレーションが必要か（最大リトライ到達時 true） */
  escalationRequired: boolean;
  /** 全イテレーションのログ */
  iterations: ReviewIteration[];
  /** 最終レビュー結果 */
  lastReviewResult: ReviewResult;
  /**
   * 最終レビューで残った warning 指摘（自動修正対象外）
   * ユーザーが必要に応じて Pick して追加要件として渡すことを想定
   */
  warnings: ReviewFinding[];
}

/**
 * レビューループのオプション
 */
export interface ReviewLoopOptions {
  /** 最大リトライ回数（デフォルト: 3） */
  maxRetries?: number;
  /** SubprocessReviewRunner のインスタンス（DI用） */
  reviewRunner?: SubprocessReviewRunner;
  /** レビュータイムアウト（ミリ秒） */
  reviewTimeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;

/** diff stat の最大行数。超えた場合はサマリ行のみに切り詰める */
export const DIFF_STAT_MAX_LINES = 50;
/** diff stat の最大文字数。超えた場合はサマリ行のみに切り詰める */
export const DIFF_STAT_MAX_CHARS = 2000;

/**
 * git diff --stat を取得する。
 * 出力が上限（行数または文字数）を超えた場合はサマリ行（末尾の 'N files changed, ...' 行）のみに切り詰める。
 * git コマンド失敗時は undefined を返す。
 */
export function getDiffStat(repoPath: string, branch: string): string | undefined {
  let raw: string;
  try {
    raw = execSync(`git diff --stat main...${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    try {
      raw = execSync('git diff --stat HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return undefined;
    }
  }

  if (!raw.trim()) {
    return undefined;
  }

  return truncateDiffStat(raw);
}

/**
 * diff stat 出力を上限ガードし、必要に応じてサマリ行のみに切り詰める。
 */
export function truncateDiffStat(raw: string): string {
  const lines = raw.split('\n');
  // 末尾空行を除いた行数で判定
  const nonEmptyLines = lines.filter((l) => l.trim() !== '');

  if (nonEmptyLines.length <= DIFF_STAT_MAX_LINES && raw.length <= DIFF_STAT_MAX_CHARS) {
    return raw.trim();
  }

  // サマリ行は末尾の非空行（例: " 5 files changed, 100 insertions(+), 20 deletions(-)"）
  const summaryLine = nonEmptyLines[nonEmptyLines.length - 1];
  return summaryLine?.trim() ?? raw.trim();
}

/**
 * diff を取得する
 */
export function getDiff(repoPath: string, branch: string): string {
  try {
    return execSync(`git diff main...${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
  } catch {
    // ブランチが存在しない等の場合は HEAD との diff を試行
    try {
      return execSync('git diff HEAD', {
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return '';
    }
  }
}

/**
 * レビュー指摘事項を修正プロンプトに変換する
 */
export function buildFixPrompt(
  reviewResult: ReviewResult,
  taskDescription: string,
  repoPath: string,
): string {
  // 自動修正対象は error のみ。warning はユーザー判断に委ねる
  const findings = reviewResult.findings
    .filter((f) => f.severity === 'error')
    .map((f) => {
      const location = [f.file, f.line].filter(Boolean).join(':');
      const prefix = location ? `[${location}] ` : '';
      return `- [${f.severity.toUpperCase()}] ${prefix}${f.message}`;
    })
    .join('\n');

  return `あなたはソフトウェアエンジニアです。セルフレビューで以下の指摘を受けました。修正してください。

## タスク概要
${taskDescription}

## 作業ディレクトリ
${repoPath}

## レビュー結果
判定: ${reviewResult.verdict}
要約: ${reviewResult.summary}

## 指摘事項
${findings}

## 修正ルール
1. 指摘事項を一つずつ確認し、すべて修正してください
2. 修正後はテストが通ることを確認してください
3. 修正が完了したら git add && git commit してください
4. 最後に「修正完了」と出力してください`;
}

/**
 * 修正エージェントを実行する
 */
async function runFixAgent(prompt: string, cwd: string): Promise<string> {
  let output = '';

  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
    },
  })) {
    if (message.type === 'assistant') {
      const content = message.message?.content ?? [];
      for (const block of content) {
        if ('text' in block && block.text) {
          output += block.text;
          process.stdout.write(`[fix-agent] ${block.text}\n`);
        }
      }
    }
  }

  return output;
}

/**
 * セルフレビュー→修正ループを実行する
 *
 * 実装完了後の diff に対してレビューを実行し、NG の場合は
 * 修正エージェントに差し戻して再レビューを行う。
 * 最大リトライ回数に達した場合はエスカレーションフラグを立てて終了する。
 */
export async function runReviewLoop(
  repoPath: string,
  branch: string,
  taskDescription: string,
  options: ReviewLoopOptions = {},
): Promise<ReviewLoopResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const reviewRunner =
    options.reviewRunner ?? new SubprocessReviewRunner({
      timeoutMs: options.reviewTimeoutMs,
    });

  const iterations: ReviewIteration[] = [];
  let lastReviewResult: ReviewResult | undefined;

  for (let i = 0; i <= maxRetries; i++) {
    const iterationNumber = i + 1;
    console.log(`[review-loop] iteration ${iterationNumber}/${maxRetries + 1}: getting diff`);

    // diff を取得
    const diff = getDiff(repoPath, branch);
    if (!diff.trim()) {
      console.log('[review-loop] no diff found, skipping review');
      const emptyResult: ReviewResult = {
        verdict: 'OK',
        summary: 'No changes to review',
        findings: [],
      };
      iterations.push({
        iteration: iterationNumber,
        reviewResult: emptyResult,
        timestamp: new Date(),
      });
      return {
        finalVerdict: 'OK',
        escalationRequired: false,
        iterations,
        lastReviewResult: emptyResult,
        warnings: [],
      };
    }

    // レビュー実行
    console.log(`[review-loop] iteration ${iterationNumber}: running review`);
    let reviewResult: ReviewResult;
    try {
      reviewResult = await reviewRunner.review(diff, taskDescription);
    } catch (error) {
      if (error instanceof ReviewError) {
        console.error(`[review-loop] review error at iteration ${iterationNumber}: ${error.message}`);
        // レビュー自体が失敗した場合はエスカレーション
        const errorResult: ReviewResult = {
          verdict: 'NG',
          summary: `Review failed: ${error.message}`,
          findings: [],
        };
        iterations.push({
          iteration: iterationNumber,
          reviewResult: errorResult,
          timestamp: new Date(),
        });
        return {
          finalVerdict: 'NG',
          escalationRequired: true,
          iterations,
          lastReviewResult: errorResult,
          warnings: [],
        };
      }
      throw error;
    }

    lastReviewResult = reviewResult;
    console.log(`[review-loop] iteration ${iterationNumber}: verdict=${reviewResult.verdict}`);

    // OK の場合はループ終了
    if (reviewResult.verdict === 'OK') {
      iterations.push({
        iteration: iterationNumber,
        reviewResult,
        timestamp: new Date(),
      });
      return {
        finalVerdict: 'OK',
        escalationRequired: false,
        iterations,
        lastReviewResult: reviewResult,
        warnings: reviewResult.findings.filter(f => f.severity === 'warning'),
      };
    }

    // NG で最後のイテレーションの場合はリトライしない
    if (i === maxRetries) {
      iterations.push({
        iteration: iterationNumber,
        reviewResult,
        timestamp: new Date(),
      });
      break;
    }

    // NG の場合: 修正エージェントを起動
    console.log(`[review-loop] iteration ${iterationNumber}: NG - launching fix agent`);
    const fixPrompt = buildFixPrompt(reviewResult, taskDescription, repoPath);
    let fixDescription: string;
    try {
      fixDescription = await runFixAgent(fixPrompt, repoPath);
    } catch (error) {
      console.error(`[review-loop] fix agent failed at iteration ${iterationNumber}:`, error);
      fixDescription = `Fix agent failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    iterations.push({
      iteration: iterationNumber,
      reviewResult,
      fixDescription,
      timestamp: new Date(),
    });
  }

  // 最大リトライ到達
  console.log(`[review-loop] max retries (${maxRetries}) reached, escalating`);
  return {
    finalVerdict: 'NG',
    escalationRequired: true,
    iterations,
    lastReviewResult: lastReviewResult!,
    warnings: lastReviewResult!.findings.filter(f => f.severity === 'warning'),
  };
}

/**
 * レビューループ結果を通知用テキストに変換する
 */
export function formatReviewLoopResult(result: ReviewLoopResult): string {
  const lines: string[] = [];

  if (result.finalVerdict === 'OK') {
    lines.push('✅ *セルフレビュー通過*');
  } else if (result.escalationRequired) {
    lines.push('⚠️ *セルフレビュー未通過（エスカレーション）*');
  } else {
    lines.push('❌ *セルフレビュー NG*');
  }

  lines.push(`イテレーション数: ${result.iterations.length}`);
  lines.push(`最終判定: ${result.lastReviewResult.verdict}`);
  lines.push(`要約: ${result.lastReviewResult.summary}`);

  const errors = result.lastReviewResult.findings.filter(f => f.severity === 'error');
  if (errors.length > 0) {
    lines.push('\n*未解決エラー:*');
    for (const f of errors) {
      const location = [f.file, f.line].filter(Boolean).join(':');
      const prefix = location ? `[${location}] ` : '';
      lines.push(`  [ERROR] ${prefix}${f.message}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\n*警告（要確認）:*');
    for (const f of result.warnings) {
      const location = [f.file, f.line].filter(Boolean).join(':');
      const prefix = location ? `[${location}] ` : '';
      lines.push(`  [WARNING] ${prefix}${f.message}`);
    }
  }

  return lines.join('\n');
}
