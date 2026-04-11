import { FlowSignal, RetryContext, TaskContext } from '../types';
import { StoryFile, TaskFile } from '../../vault/reader';
import { formatReviewLoopResult, buildRetryContext } from '../../review';
import { traceOperation } from '../../telemetry/operation';
import type { ReviewFinding } from '../../review/types';

/**
 * タスク実装のプロンプトを生成する
 */
function buildTaskPrompt(task: TaskFile, story: StoryFile, cwd: string, useWorktree: boolean): string {
  const prerequisite = useWorktree
    ? `- ワークツリーは既に feature/${task.slug} ブランチで作成済みです。直接作業してください。git checkout main や git pull は実行しないでください。`
    : `- mainブランチは最新の状態に同期済みです。git checkout main や git pull は不要です。直接 feature ブランチを作成してください。`;

  return `あなたは優秀なソフトウェアエンジニアです。以下のタスクを実装してください。

## ストーリー: ${story.slug}
${story.content}

## タスク: ${task.slug}
${task.content}

## 作業環境
- リポジトリパス: ${cwd}
- ブランチ名規則: feature/${task.slug}

## 前提条件
${prerequisite}

## 重要なルール
1. プロジェクトのCLAUDE.mdとREADMEを最初に読み、設計思想・規約に沿ってシンプルに実装すること。既存設計から逸脱した過剰な実装は避けること
2. 作業は必ず ${cwd} ディレクトリ内で行うこと
3. 実装には必ず対応するテストを作成すること。テストはユニットテストを基本とし、必要に応じて統合テストも書くこと。既存テストが壊れていないことも確認すること
4. 実装完了前に既存のテストスイートを実行し、既存テストが壊れていないことを確認すること
5. 実装が完了したらタスクの完了条件をすべて確認すること
6. PRの作成は自動で行われるため、\`gh pr create\` は実行しないこと
7. 実装完了後、最後に「実装完了」と出力すること

それでは実装を開始してください。`;
}

/** diff stat の最大文字数（トークン量制御） */
export const MAX_DIFF_STAT_LENGTH = 2000;

/** diff stat の最大行数（トークン量制御） */
export const MAX_DIFF_STAT_LINES = 50;

/**
 * diff stat を安全に切り詰める。
 * 行数または文字数の上限を超えた場合は、サマリ行（末尾の 'N files changed, ...' 行）のみに切り詰める。
 */
export function truncateDiffStat(
  diffStat: string,
  maxLength: number = MAX_DIFF_STAT_LENGTH,
  maxLines: number = MAX_DIFF_STAT_LINES,
): string {
  const lines = diffStat.split('\n');
  if (diffStat.length <= maxLength && lines.length <= maxLines) return diffStat;

  // サマリ行を抽出（末尾の非空行、通常 "N files changed, ..." の形式）
  const summaryLine = lines.filter((l) => l.trim()).pop() ?? diffStat;
  return `${summaryLine}\n(詳細省略: 出力が上限を超えたためサマリ行のみ表示)`;
}

/**
 * ReviewFinding[] をリスト形式に整形する
 */
export function formatErrorFindings(findings: ReviewFinding[]): string {
  return findings
    .map((f) => {
      const location = f.file
        ? f.line
          ? `${f.file}:${f.line}`
          : f.file
        : '(ファイル不明)';
      return `- **${location}**: ${f.message}`;
    })
    .join('\n');
}

/**
 * retry時のプロンプトを生成する
 */
function buildRetryPrompt(task: TaskFile, cwd: string, retryContext: RetryContext, useWorktree: boolean): string {
  const branchInstruction = useWorktree
    ? `- ワークツリーは既に feature/${task.slug} ブランチで作成済みです。直接作業してください。git checkout main や git pull は実行しないでください。`
    : `- feature/${task.slug} ブランチが既に存在します。\`git checkout feature/${task.slug}\` してから作業を開始してください。git checkout main や新規ブランチ作成（git checkout -b）は不要です。`;

  let prompt = `前回の実装を修正してください。タスク: ${task.slug}\n\n${task.content}\n\n作業ディレクトリ: ${cwd}\n\n## 前提条件\n${branchInstruction}\n\n## 修正依頼\n${retryContext.reason}`;

  // レビュー文脈がある場合は構造化セクションを追加
  if (retryContext.diffStat) {
    prompt += `\n\n## 前回の変更概要\n\`\`\`\n${truncateDiffStat(retryContext.diffStat)}\n\`\`\``;
  }

  if (retryContext.reviewSummary) {
    prompt += `\n\n## レビュー結果サマリ\n${retryContext.reviewSummary}`;
  }

  if (retryContext.errorFindings && retryContext.errorFindings.length > 0) {
    prompt += `\n\n## 修正が必要なエラー\n${formatErrorFindings(retryContext.errorFindings)}`;
  }

  prompt += `\n\n## 重要\n- プロジェクトのCLAUDE.mdとREADMEを読み、設計思想・規約に沿ってシンプルに実装すること。既存設計から逸脱した過剰な実装は避けること\n- 実装には必ず対応するテストを作成すること。テストはユニットテストを基本とし、必要に応じて統合テストも書くこと。既存テストが壊れていないことも確認すること\n- 実装完了前に既存のテストスイートを実行し、既存テストが壊れていないことを確認すること\n- PRの作成は自動で行われるため、\`gh pr create\` は実行しないこと\n\n上記の修正依頼を踏まえて、完了条件を再確認しながら修正してください。`;

  return prompt;
}

/**
 * 実装 step（Agent実行 + セルフレビューループ）
 *
 * - retry理由があればretryプロンプト、なければ初回プロンプトでAgentを起動する
 * - レビューOK → reviewResultをcontextにセットして continue
 * - レビューNG → 通知して retry from: 'implementation'
 */
export async function handleImplementation(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, repoPath, notifier, deps } = ctx;
  const branch = `feature/${task.slug}`;
  const worktreePath = ctx.get('worktreePath');
  const cwd = worktreePath ?? repoPath;
  const useWorktree = worktreePath !== undefined;

  deps.updateFileStatus(task.filePath, 'Doing');

  const retryContext = ctx.getRetryContext();
  const rejectionReason = ctx.get('rejectionReason');

  let prompt = retryContext
    ? buildRetryPrompt(task, cwd, retryContext, useWorktree)
    : buildTaskPrompt(task, story, cwd, useWorktree);

  // 却下理由がある場合はプロンプトに追記
  if (rejectionReason) {
    prompt += `\n\n## 前回の却下理由\n${rejectionReason}\n上記の指摘を踏まえて実装してください。`;
    // 次回の implementation 実行時に残らないようクリア
    ctx.set('rejectionReason', undefined);
  }

  await traceOperation(
    { type: 'agent', waitType: 'agent' },
    () => deps.runAgent(prompt, cwd),
  );

  const reviewResult = await traceOperation(
    { type: 'review', waitType: 'agent' },
    () => deps.runReviewLoop(cwd, branch, task.content),
  );
  const reviewMessage = formatReviewLoopResult(reviewResult);

  if (reviewResult.finalVerdict === 'OK') {
    ctx.set('reviewResult', reviewResult);
    await notifier.notify(
      `*セルフレビュー結果* (${task.slug})\n\n${reviewMessage}`,
      story.slug,
    );
    return { kind: 'continue' };
  }

  // レビューNG: retryContext を組み立てて ctx にセット
  const retryCtx = buildRetryContext(reviewResult);

  // diffStat を取得（失敗しても retry は継続する）
  try {
    const diffStat = deps.execCommand(`git diff main...${branch} --stat`, cwd);
    if (diffStat.trim()) {
      retryCtx.diffStat = diffStat.trim();
    }
  } catch {
    // diffStat 取得失敗は無視（retry の必須情報ではない）
  }

  ctx.setRetryContext(retryCtx);

  // escalation有無にかかわらず通知してretry
  if (reviewResult.escalationRequired) {
    await notifier.notify(
      `⚠️ *セルフレビュー未通過（エスカレーション）*: ${task.slug}\n\n${reviewMessage}`,
      story.slug,
    );
  } else {
    await notifier.notify(
      `*セルフレビュー結果* (${task.slug})\n\n${reviewMessage}`,
      story.slug,
    );
  }

  return { kind: 'retry', from: 'implementation', reason: 'セルフレビュー未通過' };
}
