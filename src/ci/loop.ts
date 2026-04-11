import { execSync } from 'child_process';
import {
  CIPollingOptions,
  CIPollingResult,
  CIAttemptResult,
  CIPollingError,
  CIPollingTimeoutError,
} from './types';
import { pollCIStatus, hasCIWorkflows } from './poller';
import { ClaudeBackend } from '../agent/backend';
import type { AgentBackend } from '../agent/backend';

const DEFAULT_MAX_RETRIES = 3;

/**
 * CI 失敗時の修正プロンプトを生成する
 */
export function buildCIFixPrompt(
  failureLogs: string,
  taskDescription: string,
  repoPath: string,
): string {
  return `あなたはソフトウェアエンジニアです。CI（GitHub Actions）が失敗しました。ログを確認して修正してください。

## タスク概要
${taskDescription}

## 作業ディレクトリ
${repoPath}

## CI 失敗ログ
\`\`\`
${failureLogs}
\`\`\`

## 修正ルール
1. CI失敗ログを分析し、原因を特定してください
2. 必要な修正を実施してください
3. 修正後はテストが通ることを確認してください
4. 修正が完了したら git add && git commit してください
5. 最後に「修正完了」と出力してください`;
}

/**
 * CI 修正エージェントを実行する（AgentBackend 経由）
 */
async function runCIFixAgent(prompt: string, cwd: string, backend?: AgentBackend): Promise<string> {
  const agent = backend ?? new ClaudeBackend();
  const output = await agent.run(prompt, {
    cwd,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    permissionMode: 'bypassPermissions',
  });
  return output;
}

/**
 * 修正後のコミットをリモートにプッシュする
 */
export function pushFix(repoPath: string, branch: string): void {
  execSync(`git push origin ${branch}`, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  console.log(`[ci-loop] pushed fix to ${branch}`);
}

/**
 * CI ポーリング→失敗時修正ループを実行する
 *
 * PR 作成後に CI の完了を待ち、失敗時は修正エージェントに差し戻して
 * 修正→プッシュ→再ポーリングのループを回す。
 * 最大リトライ回数に到達した場合はエスカレーションとしてループを終了する。
 */
export async function runCIPollingLoop(
  repoPath: string,
  branch: string,
  taskDescription: string,
  options: CIPollingOptions = {},
): Promise<CIPollingResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const attemptResults: CIAttemptResult[] = [];

  // ワークフローファイルが存在しない場合は即座にスキップ
  if (!hasCIWorkflows(repoPath)) {
    console.log(`[ci-loop] no CI workflow files found in ${repoPath}/.github/workflows/, skipping CI polling`);
    return {
      finalStatus: 'no_ci',
      attempts: 0,
      attemptResults: [],
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptNumber = attempt + 1;
    console.log(`[ci-loop] attempt ${attemptNumber}/${maxRetries + 1}: polling CI status`);

    // CI ポーリング
    try {
      const ciResult = await pollCIStatus(repoPath, branch, options);

      // CI 成功
      if (ciResult.status === 'success') {
        console.log(`[ci-loop] attempt ${attemptNumber}: CI passed`);
        attemptResults.push({
          attempt: attemptNumber,
          ciResult,
          timestamp: new Date(),
        });
        return {
          finalStatus: 'success',
          attempts: attemptNumber,
          attemptResults,
          lastCIResult: ciResult,
        };
      }

      // CI 失敗 — 最後の試行の場合はリトライしない
      console.log(`[ci-loop] attempt ${attemptNumber}: CI failed`);

      if (attempt === maxRetries) {
        attemptResults.push({
          attempt: attemptNumber,
          ciResult,
          timestamp: new Date(),
        });
        break;
      }

      // 修正エージェントを起動
      console.log(`[ci-loop] attempt ${attemptNumber}: launching CI fix agent`);
      const failureLogs = ciResult.failureLogs ?? ciResult.summary;
      const fixPrompt = buildCIFixPrompt(failureLogs, taskDescription, repoPath);

      let fixDescription: string;
      try {
        fixDescription = await runCIFixAgent(fixPrompt, repoPath);
      } catch (error) {
        console.error(`[ci-loop] CI fix agent failed at attempt ${attemptNumber}:`, error);
        fixDescription = `CI fix agent failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      // 修正をプッシュ
      try {
        pushFix(repoPath, branch);
      } catch (error) {
        console.error(`[ci-loop] push failed at attempt ${attemptNumber}:`, error);
        fixDescription += `\nPush failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      attemptResults.push({
        attempt: attemptNumber,
        ciResult,
        fixDescription,
        timestamp: new Date(),
      });
    } catch (error) {
      if (error instanceof CIPollingTimeoutError) {
        console.log(`[ci-loop] attempt ${attemptNumber}: CI polling timed out`);
        attemptResults.push({
          attempt: attemptNumber,
          ciResult: {
            status: 'failure',
            summary: `Polling timed out after ${error.maxWaitMs}ms`,
          },
          timestamp: new Date(),
        });
        return {
          finalStatus: 'timeout',
          attempts: attemptNumber,
          attemptResults,
        };
      }

      if (error instanceof CIPollingError) {
        console.error(`[ci-loop] CI polling error at attempt ${attemptNumber}: ${error.message}`);
        attemptResults.push({
          attempt: attemptNumber,
          ciResult: {
            status: 'failure',
            summary: `CI polling error: ${error.message}`,
          },
          timestamp: new Date(),
        });
        return {
          finalStatus: 'failure',
          attempts: attemptNumber,
          attemptResults,
        };
      }

      throw error;
    }
  }

  // 最大リトライ到達
  console.log(`[ci-loop] max retries (${maxRetries}) reached, escalating`);
  return {
    finalStatus: 'max_retries_exceeded',
    attempts: attemptResults.length,
    attemptResults,
    lastCIResult: attemptResults[attemptResults.length - 1]?.ciResult,
  };
}

/**
 * CI ポーリング結果を通知用テキストに変換する
 */
export function formatCIPollingResult(result: CIPollingResult): string {
  const lines: string[] = [];

  switch (result.finalStatus) {
    case 'success':
      lines.push('✅ *CI通過*');
      break;
    case 'failure':
      lines.push('❌ *CI失敗*');
      break;
    case 'timeout':
      lines.push('⏱️ *CIタイムアウト*');
      break;
    case 'max_retries_exceeded':
      lines.push('⚠️ *CI失敗（最大リトライ到達）*');
      break;
    case 'no_ci':
      lines.push('ℹ️ *CI未設定*（ワークフローファイルなし）');
      break;
  }

  lines.push(`試行回数: ${result.attempts}`);

  if (result.lastCIResult) {
    lines.push(`最終結果: ${result.lastCIResult.summary}`);
    if (result.lastCIResult.runUrl) {
      lines.push(`URL: ${result.lastCIResult.runUrl}`);
    }
  }

  // 修正履歴
  const fixAttempts = result.attemptResults.filter((a) => a.fixDescription);
  if (fixAttempts.length > 0) {
    lines.push('');
    lines.push('*修正履歴:*');
    for (const a of fixAttempts) {
      lines.push(`  試行 ${a.attempt}: 修正実施済み`);
    }
  }

  return lines.join('\n');
}
