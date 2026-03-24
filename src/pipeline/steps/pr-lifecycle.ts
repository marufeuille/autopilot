import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FlowSignal, TaskContext } from '../types';
import { StoryFile, TaskFile } from '../../vault/reader';
import { ReviewLoopResult, formatReviewLoopResult } from '../../review';
import { formatCIPollingResult } from '../../ci';
import { runMergePollingLoop } from '../../merge';
import { NotificationContext } from '../../notification';
import { RunnerDeps } from '../../runner-deps';
import { detectNoRemote } from '../../git';

/**
 * PR 本文用のセルフレビューサマリーを生成する
 */
function formatReviewSummaryForPR(result: ReviewLoopResult): string {
  const lines: string[] = ['## セルフレビュー結果', ''];
  lines.push(result.finalVerdict === 'OK' ? '✅ **セルフレビュー通過**' : '⚠️ **セルフレビュー未通過**');
  lines.push('');
  lines.push(`- イテレーション数: ${result.iterations.length}`);
  lines.push(`- 最終判定: ${result.lastReviewResult.verdict}`);
  lines.push(`- 要約: ${result.lastReviewResult.summary}`);
  return lines.join('\n');
}

/**
 * PR を作成し URL を返す。失敗時は空文字を返す。
 */
function createPullRequest(
  repoPath: string,
  branch: string,
  task: TaskFile,
  story: StoryFile,
  reviewLoopResult: ReviewLoopResult,
  deps: Pick<RunnerDeps, 'execCommand'>,
): string {
  const reviewSummary = formatReviewSummaryForPR(reviewLoopResult);
  const body = `## 概要\n\nタスク: ${task.slug}\nストーリー: ${story.slug}\n\n${task.content}\n\n${reviewSummary}`;
  const tmpFile = join(tmpdir(), `autopilot-pr-body-${Date.now()}.md`);

  try {
    writeFileSync(tmpFile, body, 'utf-8');
    deps.execCommand(`git push -u origin ${branch}`, repoPath);
    const prUrl = deps.execCommand(
      `gh pr create --base main --head ${branch} --title "${task.slug}" --body-file ${tmpFile}`,
      repoPath,
    ).trim();
    console.log(`[pr-lifecycle] PR created: ${prUrl}`);
    return prUrl;
  } catch {
    try {
      return deps.execCommand(`gh pr view ${branch} --json url -q .url`, repoPath).trim();
    } catch {
      return '';
    }
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * PRライフサイクル step（PR作成 → CI → マージ待機）
 *
 * - PR作成
 * - CIポーリング: 失敗 → retry from: 'implementation'
 * - 「マージ準備完了」Slack通知
 * - ワークツリークリーンアップ（手動マージ時の --delete-branch 問題回避）
 * - MERGEDポーリング: merged → continue, closed → retry from: 'implementation'
 */
export async function handlePRLifecycle(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, repoPath, notifier, deps } = ctx;
  const branch = `feature/${task.slug}`;
  const reviewResult = ctx.get('reviewResult');

  // no-remote 検出時はローカルコミットのみで完結
  if (detectNoRemote(repoPath)) {
    console.warn('[pr-lifecycle] リモートリポジトリが見つかりません。PR作成・push・CI・レビュー通知をスキップします');

    // ローカルブランチの最新コミットSHAを取得
    let commitSha: string;
    try {
      commitSha = deps.execCommand('git rev-parse HEAD', repoPath).trim();
    } catch {
      commitSha = 'unknown';
    }

    ctx.set('prUrl', '');
    ctx.set('localOnly', true);
    ctx.set('commitSha', commitSha);

    await notifier.notify(
      `ℹ️ ローカルオンリーモード: \`${task.slug}\`\nリモートなしのためPR作成をスキップしました\nコミットSHA: ${commitSha}`,
      story.slug,
    );

    return { kind: 'continue' };
  }

  // PR 作成
  const prUrl = createPullRequest(
    repoPath,
    branch,
    task,
    story,
    reviewResult!,
    deps,
  );
  ctx.set('prUrl', prUrl);

  if (!prUrl) {
    await notifier.notify(`❌ PR作成失敗: ${task.slug}`, story.slug);
    return { kind: 'retry', from: 'implementation', reason: 'PR作成失敗' };
  }

  // CI ポーリング
  const ciResult = await deps.runCIPollingLoop(repoPath, branch, task.content);
  const ciMessage = formatCIPollingResult(ciResult);
  const ciRunUrl = ciResult.lastCIResult?.runUrl;

  if (ciResult.finalStatus !== 'success') {
    const ciEscCtx: NotificationContext = {
      eventType: 'ci_escalation',
      taskSlug: task.slug,
      storySlug: story.slug,
      prUrl,
      ciSummary: ciMessage,
      ciRunUrl,
    };
    // CIエスカレーション通知
    await notifier.notify(
      `❌ *CI未通過*: \`${task.slug}\`\n*PR*: ${prUrl}\n${ciMessage}`,
      story.slug,
    );
    return { kind: 'retry', from: 'implementation', reason: `CI未通過: ${ciResult.finalStatus}` };
  }

  // マージ準備完了通知（ユーザーに手動マージを促す）
  await notifier.notify(
    `✅ *マージ準備完了*: \`${task.slug}\`\n*PR*: ${prUrl}\nCIが通過しました。GitHubから手動でマージしてください。`,
    story.slug,
  );

  // ワークツリーのクリーンアップ（手動マージ時の --delete-branch 問題回避）
  const worktreePath = ctx.get('worktreePath');
  if (worktreePath) {
    try {
      await deps.removeWorktree(repoPath, worktreePath);
      ctx.set('worktreePath', undefined);
      console.log(`[pr-lifecycle] worktree cleaned up before merge polling: ${worktreePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pr-lifecycle] worktreeの削除に失敗しましたが、ポーリングを続行します: ${message}`);
    }
  }

  // MERGED ポーリング（ユーザーが手動マージするのを待機）
  const pollingResult = await runMergePollingLoop(prUrl, repoPath, deps);

  switch (pollingResult.finalStatus) {
    case 'merged':
      await notifier.notify(
        `🎉 *マージ完了*: \`${task.slug}\`\n*PR*: ${prUrl}\nマージが検知されました。次のステップへ進みます。`,
        story.slug,
      );
      return { kind: 'continue' };

    case 'closed':
      await notifier.notify(
        `❌ *PRクローズ検知*: \`${task.slug}\`\n*PR*: ${prUrl}\nPRがマージされずにクローズされました。実装からやり直します。`,
        story.slug,
      );
      return { kind: 'retry', from: 'implementation', reason: 'PRがマージされずにクローズされました' };

    case 'timeout':
      await notifier.notify(
        `⏰ *マージ待機タイムアウト*: \`${task.slug}\`\n*PR*: ${prUrl}\nマージ待機がタイムアウトしました。実装からやり直します。`,
        story.slug,
      );
      return { kind: 'retry', from: 'implementation', reason: 'マージ待機タイムアウト' };

    case 'error':
      await notifier.notify(
        `❌ *マージポーリングエラー*: \`${task.slug}\`\n*PR*: ${prUrl}\nPRステータスの取得で連続エラーが発生しました。実装からやり直します。`,
        story.slug,
      );
      return { kind: 'retry', from: 'implementation', reason: 'マージポーリングエラー' };
  }
}
