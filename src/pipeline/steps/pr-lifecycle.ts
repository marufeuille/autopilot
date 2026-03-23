import { writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { FlowSignal, TaskContext } from '../types';
import { StoryFile, TaskFile } from '../../vault/reader';
import { ReviewLoopResult, formatReviewLoopResult } from '../../review';
import { formatCIPollingResult } from '../../ci';
import { executeMerge, MergeError, formatMergeErrorMessage } from '../../merge';
import { generateApprovalId } from '../../notification/approval-id';
import { buildMergeApprovalMessage, buildMergeCompletedMessage } from '../../notification';
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
 * PRライフサイクル step（PR作成 → CI → マージ承認 → マージ）
 *
 * - PR作成
 * - CIポーリング: 失敗 → retry from: 'implementation'
 * - マージ承認: 拒否 → retry from: 'implementation'
 * - マージ実行: 失敗 → retry from: 'pr-lifecycle'
 * - 成功 → continue
 *
 * マージ条件の検証は executeMerge 内の1箇所のみで行う（二重バリデーション廃止）。
 */
export async function handlePRLifecycle(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, repoPath, notifier, deps } = ctx;
  const branch = `feature/${task.slug}`;
  const reviewResult = ctx.get('reviewResult') as ReviewLoopResult | undefined;

  // no-remote 検出時はローカルコミットのみで完結
  if (detectNoRemote(repoPath)) {
    console.warn('[pr-lifecycle] リモートリポジトリが見つかりません。PR作成・push・CI・レビュー通知をスキップします');

    // ローカルブランチの最新コミットSHAを取得
    let commitSha: string;
    try {
      commitSha = execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe' }).toString().trim();
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
    // CIエスカレーション通知（buildCIEscalationMessageがあれば使う、なければシンプルに）
    await notifier.notify(
      `❌ *CI未通過*: \`${task.slug}\`\n*PR*: ${prUrl}\n${ciMessage}`,
      story.slug,
    );
    return { kind: 'retry', from: 'implementation', reason: `CI未通過: ${ciResult.finalStatus}` };
  }

  // マージ承認リクエスト
  const mergeApprovalId = generateApprovalId(story.slug, `${task.slug}-merge`);
  const mergeCtx: NotificationContext = {
    eventType: 'merge_approval',
    taskSlug: task.slug,
    storySlug: story.slug,
    prUrl,
    ciSummary: ciMessage,
    ciRunUrl,
    mergeReady: true,
  };
  const mergeMessage = buildMergeApprovalMessage(mergeCtx);

  const mergeApproval = await notifier.requestApproval(
    mergeApprovalId,
    mergeMessage,
    { approve: 'マージ実行', reject: '差し戻し' },
    story.slug,
  );

  if (mergeApproval.action === 'reject') {
    return {
      kind: 'retry',
      from: 'implementation',
      reason: mergeApproval.reason,
    };
  }

  // マージ実行（バリデーションは executeMerge 内のみ）
  await notifier.notify(
    `⏳ *マージ処理中*: \`${task.slug}\`\n*PR*: ${prUrl}\nマージを実行しています...`,
    story.slug,
  );

  try {
    executeMerge(prUrl, repoPath, deps, { skipValidation: false });
    await notifier.notify(buildMergeCompletedMessage(task.slug, prUrl), story.slug);
    return { kind: 'continue' };
  } catch (mergeError) {
    if (mergeError instanceof MergeError) {
      await notifier.notify(
        `❌ *マージ失敗*: \`${task.slug}\`\n*PR*: ${prUrl}\n*エラーコード*: \`${mergeError.code}\`\n*原因*: ${formatMergeErrorMessage(mergeError)}`,
        story.slug,
      );
    } else {
      const msg = mergeError instanceof Error ? mergeError.message : String(mergeError);
      await notifier.notify(
        `❌ *マージ失敗*: \`${task.slug}\`\n*PR*: ${prUrl}\n*原因*: ${msg}`,
        story.slug,
      );
    }
    return {
      kind: 'retry',
      from: 'pr-lifecycle',
      reason: `マージ失敗: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`,
    };
  }
}
