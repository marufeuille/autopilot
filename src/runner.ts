import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { StoryFile, TaskFile, TaskStatus, getStoryTasks } from './vault/reader';
import { updateFileStatus, createTaskFile, TaskDraft } from './vault/writer';
import { decomposeTasks } from './decomposer';
import {
  NotificationBackend,
  generateApprovalId,
  buildMergeApprovalMessage,
  buildReviewEscalationMessage,
  buildCIEscalationMessage,
  NotificationContext,
} from './notification';
import { syncMainBranch, GitSyncError } from './git';
import { runReviewLoop, formatReviewLoopResult, ReviewLoopResult } from './review';
import { runCIPollingLoop, formatCIPollingResult, CIPollingResult, CIPollingOptions } from './ci';

function buildTaskPrompt(task: TaskFile, story: StoryFile, repoPath: string): string {
  return `あなたは優秀なソフトウェアエンジニアです。以下のタスクを実装してください。

## ストーリー: ${story.slug}
${story.content}

## タスク: ${task.slug}
${task.content}

## 作業環境
- リポジトリパス: ${repoPath}
- ブランチ名規則: feature/${task.slug}

## 前提条件
- mainブランチは最新の状態に同期済みです。git checkout main や git pull は不要です。直接 feature ブランチを作成してください。

## 重要なルール
1. 作業は必ず ${repoPath} ディレクトリ内で行うこと
2. 実装が完了したらタスクの完了条件をすべて確認すること
3. PRの作成は自動で行われるため、\`gh pr create\` は実行しないこと
4. 実装完了後、最後に「実装完了」と出力すること

それでは実装を開始してください。`;
}

/**
 * レビューループ結果をPR本文用のMarkdownサマリーに変換する
 */
export function formatReviewSummaryForPR(result: ReviewLoopResult): string {
  const lines: string[] = ['## セルフレビュー結果', ''];

  if (result.finalVerdict === 'OK') {
    lines.push('✅ **セルフレビュー通過**');
  } else {
    lines.push('⚠️ **セルフレビュー未通過**');
  }
  lines.push('');

  lines.push(`- イテレーション数: ${result.iterations.length}`);
  lines.push(`- 最終判定: ${result.lastReviewResult.verdict}`);
  lines.push(`- 要約: ${result.lastReviewResult.summary}`);

  // 各イテレーションの修正履歴
  if (result.iterations.length > 1) {
    lines.push('');
    lines.push('### 修正履歴');
    lines.push('');
    for (const iter of result.iterations) {
      const verdict = iter.reviewResult.verdict === 'OK' ? '✅' : '❌';
      lines.push(`**イテレーション ${iter.iteration}**: ${verdict} ${iter.reviewResult.verdict}`);
      if (iter.reviewResult.findings.length > 0) {
        for (const f of iter.reviewResult.findings) {
          const location = [f.file, f.line].filter(Boolean).join(':');
          const prefix = location ? `\`${location}\` ` : '';
          lines.push(`  - [${f.severity.toUpperCase()}] ${prefix}${f.message}`);
        }
      }
      if (iter.fixDescription) {
        lines.push(`  - 修正実施済み`);
      }
      lines.push('');
    }
  }

  // 最終レビューの指摘事項
  if (result.lastReviewResult.findings.length > 0) {
    lines.push('### 最終レビュー指摘事項');
    lines.push('');
    for (const f of result.lastReviewResult.findings) {
      const location = [f.file, f.line].filter(Boolean).join(':');
      const prefix = location ? `\`${location}\` ` : '';
      lines.push(`- [${f.severity.toUpperCase()}] ${prefix}${f.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * セルフレビューOK後にPRを自動作成する
 * @returns PR URL（作成成功時）または空文字（失敗時）
 */
export function createPullRequest(
  repoPath: string,
  branch: string,
  task: TaskFile,
  story: StoryFile,
  reviewLoopResult: ReviewLoopResult,
): string {
  const reviewSummary = formatReviewSummaryForPR(reviewLoopResult);
  const body = `## 概要\n\nタスク: ${task.slug}\nストーリー: ${story.slug}\n\n${task.content}\n\n${reviewSummary}`;

  const tmpFile = join(tmpdir(), `autopilot-pr-body-${Date.now()}.md`);
  try {
    // 一時ファイルにbodyを書き出し
    writeFileSync(tmpFile, body, 'utf-8');

    // リモートにブランチをプッシュ
    execSync(`git push -u origin ${branch}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    // PR作成（--body-file で一時ファイル経由で渡す）
    const prUrl = execSync(
      `gh pr create --base main --head ${branch} --title "${task.slug}" --body-file ${tmpFile}`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      },
    ).trim();

    console.log(`[runner] PR created: ${prUrl}`);
    return prUrl;
  } catch (error) {
    console.error(`[runner] PR creation failed:`, error);
    // 既にPRが存在する場合はURL取得を試みる
    try {
      return execSync(`gh pr view ${branch} --json url -q .url`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch {
      return '';
    }
  } finally {
    // 一時ファイルを確実に削除
    try {
      unlinkSync(tmpFile);
    } catch {
      // 削除失敗は無視（既に存在しない場合など）
    }
  }
}

async function runClaudeAgent(prompt: string, cwd: string): Promise<void> {
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
          process.stdout.write(`[claude] ${block.text}\n`);
        }
      }
    } else if (message.type === 'result') {
      console.log(`[runner] agent result: ${message.subtype}`);
    }
  }
}

export async function runTask(
  task: TaskFile,
  story: StoryFile,
  notifier: NotificationBackend,
  repoPath: string,
): Promise<void> {
  // タスク開始承認
  console.log(`[runner] requesting start approval: ${task.slug}`);
  const startId = generateApprovalId(story.slug, task.slug);
  const startResult = await notifier.requestApproval(
    startId,
    `*タスク開始確認*\n\n*ストーリー*: ${story.slug}\n*タスク*: ${task.slug}\n\nこのタスクを開始しますか？`,
    { approve: '開始', reject: 'スキップ' },
  );

  if (startResult.action === 'reject') {
    updateFileStatus(task.filePath, 'Skipped');
    console.log(`[runner] task skipped: ${task.slug}`);
    return;
  }

  // mainブランチを最新化してからタスクを開始する
  try {
    console.log(`[runner] syncing main branch before task: ${task.slug}`);
    await syncMainBranch(repoPath);
    console.log(`[runner] main branch synced successfully`);
  } catch (error) {
    if (error instanceof GitSyncError) {
      const errorMessage = `❌ main同期失敗: ${task.slug}\n原因: ${error.message}`;
      await notifier.notify(errorMessage);
      updateFileStatus(task.filePath, 'Failed');
      console.error(`[runner] main sync failed, task aborted: ${task.slug}`, error);
      return;
    }
    throw error;
  }

  try {
    updateFileStatus(task.filePath, 'Doing');
    console.log(`[runner] task started: ${task.slug}`);

    // Claudeエージェント実行（やり直しループ）
    let prompt = buildTaskPrompt(task, story, repoPath);
    while (true) {
      await runClaudeAgent(prompt, repoPath);

      // セルフレビューループ実行
      const branch = `feature/${task.slug}`;
      console.log(`[runner] starting self-review loop for: ${task.slug}`);
      const reviewLoopResult = await runReviewLoop(
        repoPath,
        branch,
        task.content,
      );

      // レビュー結果を通知
      const reviewMessage = formatReviewLoopResult(reviewLoopResult);
      const reviewSummary = reviewMessage;
      console.log(`[runner] self-review complete: verdict=${reviewLoopResult.finalVerdict}, iterations=${reviewLoopResult.iterations.length}, escalation=${reviewLoopResult.escalationRequired}`);

      // 通知コンテキストの基本情報
      const baseCtx: Omit<NotificationContext, 'eventType'> = {
        taskSlug: task.slug,
        storySlug: story.slug,
        reviewSummary,
      };

      // PR作成ゲート: セルフレビューOKの場合のみPRを作成
      let prUrl = '';
      let ciPollingResult: CIPollingResult | undefined;
      if (reviewLoopResult.finalVerdict === 'OK') {
        // レビュー通過の情報通知
        await notifier.notify(`*セルフレビュー結果* (${task.slug})\n\n${reviewMessage}`);

        console.log(`[runner] self-review passed, creating PR for: ${task.slug}`);
        prUrl = createPullRequest(repoPath, branch, task, story, reviewLoopResult);

        // PR作成成功時、CIポーリングループを実行
        if (prUrl) {
          console.log(`[runner] starting CI polling for: ${task.slug}`);
          ciPollingResult = await runCIPollingLoop(
            repoPath,
            branch,
            task.content,
          );
          const ciMessage = formatCIPollingResult(ciPollingResult);
          const ciRunUrl = ciPollingResult.lastCIResult?.runUrl;
          console.log(`[runner] CI polling complete: status=${ciPollingResult.finalStatus}, attempts=${ciPollingResult.attempts}`);

          if (ciPollingResult.finalStatus === 'success') {
            // CI通過 → マージ承認依頼を送信
            const mergeCtx: NotificationContext = {
              ...baseCtx,
              eventType: 'merge_approval',
              prUrl,
              ciSummary: ciMessage,
              ciRunUrl,
            };
            const mergeMessage = buildMergeApprovalMessage(mergeCtx);
            const mergeApprovalId = generateApprovalId(story.slug, `${task.slug}-merge`);
            const mergeResult = await notifier.requestApproval(
              mergeApprovalId,
              mergeMessage,
              { approve: 'マージ承認', reject: '差し戻し' },
            );
            if (mergeResult.action === 'approve') {
              break;
            }
            // 差し戻しの場合はやり直しループへ
            prompt = `前回の実装を修正してください。タスク: ${task.slug}\n\n${task.content}\n\n作業ディレクトリ: ${repoPath}\n\n## 修正依頼\n${mergeResult.reason}\n\n上記の修正依頼を踏まえて、完了条件を再確認しながら修正してください。`;
            console.log(`[runner] merge rejected, retrying task: ${task.slug}`);
            continue;
          } else if (
            ciPollingResult.finalStatus === 'max_retries_exceeded' ||
            ciPollingResult.finalStatus === 'failure' ||
            ciPollingResult.finalStatus === 'timeout'
          ) {
            // CI失敗エスカレーション通知
            const ciEscCtx: NotificationContext = {
              ...baseCtx,
              eventType: 'ci_escalation',
              prUrl,
              ciSummary: ciMessage,
              ciRunUrl,
            };
            await notifier.notify(buildCIEscalationMessage(ciEscCtx));
            console.log(`[runner] CI escalation notified for: ${task.slug}`);
          }
        }
      } else {
        console.log(`[runner] self-review NG, skipping PR creation for: ${task.slug}`);
        if (reviewLoopResult.escalationRequired) {
          // レビューNGエスカレーション通知
          const reviewEscCtx: NotificationContext = {
            ...baseCtx,
            eventType: 'review_escalation',
          };
          await notifier.notify(buildReviewEscalationMessage(reviewEscCtx));
          console.log(`[runner] review escalation notified for: ${task.slug}`);
        } else {
          // レビューNG（エスカレーションなし）の情報通知
          await notifier.notify(`*セルフレビュー結果* (${task.slug})\n\n${reviewMessage}`);
        }
      }

      const prLine = prUrl ? `\n*PR*: ${prUrl}` : '';
      const reviewLine = reviewLoopResult.escalationRequired
        ? '\n⚠️ セルフレビュー未通過（要確認）'
        : `\n✅ セルフレビュー通過 (${reviewLoopResult.iterations.length}回)`;
      const ciLine = ciPollingResult
        ? ciPollingResult.finalStatus === 'success'
          ? '\n✅ CI通過'
          : `\n❌ CI未通過 (${ciPollingResult.finalStatus})`
        : '';

      // タスク完了承認
      const doneId = generateApprovalId(story.slug, `${task.slug}-done`);
      const doneResult = await notifier.requestApproval(
        doneId,
        `*タスク完了確認*\n\n*タスク*: ${task.slug}${prLine}${reviewLine}${ciLine}\n\n実装を確認してください。`,
        { approve: '完了', reject: 'やり直し' },
      );

      if (doneResult.action === 'approve') break;

      // やり直し: 理由をプロンプトに含めて再実行
      prompt = `前回の実装を修正してください。タスク: ${task.slug}\n\n${task.content}\n\n作業ディレクトリ: ${repoPath}\n\n## 修正依頼\n${doneResult.reason}\n\n上記の修正依頼を踏まえて、完了条件を再確認しながら修正してください。`;
      console.log(`[runner] retrying task: ${task.slug}`);
    }
  } catch (error) {
    updateFileStatus(task.filePath, 'Failed');
    console.error(`[runner] task failed: ${task.slug}`, error);
    throw error;
  }

  updateFileStatus(task.filePath, 'Done');
  console.log(`[runner] task done: ${task.slug}`);
}

function formatDecompositionMessage(story: StoryFile, drafts: TaskDraft[]): string {
  const list = drafts
    .map((d, i) => `${i + 1}. *${d.title}* (\`${d.slug}\`)\n   ${d.purpose}`)
    .join('\n');
  return `*タスク分解案*\n\n*ストーリー*: ${story.slug}\n\n${list}\n\n承認するとタスクファイルを作成して実行を開始します。`;
}

async function runDecomposition(story: StoryFile, notifier: NotificationBackend): Promise<void> {
  let retryReason: string | undefined;

  while (true) {
    console.log(`[runner] decomposing story: ${story.slug}`);
    const drafts = await decomposeTasks(story, retryReason);

    const id = generateApprovalId(story.slug, 'decompose');
    const result = await notifier.requestApproval(
      id,
      formatDecompositionMessage(story, drafts),
      { approve: '承認', reject: 'やり直し' },
    );

    if (result.action === 'approve') {
      for (const draft of drafts) {
        createTaskFile(story.project, story.slug, draft);
        console.log(`[runner] task file created: ${draft.slug}`);
      }
      return;
    }

    retryReason = result.reason;
    console.log(`[runner] decomposition rejected, retrying: ${retryReason}`);
  }
}

export async function runStory(story: StoryFile, notifier: NotificationBackend): Promise<void> {
  const repoPath = `${process.env.HOME}/dev/${story.project}`;
  console.log(`[runner] starting story: ${story.slug}`);

  const tasks = await getStoryTasks(story.project, story.slug);

  if (tasks.length === 0) {
    await runDecomposition(story, notifier);
  }

  const allCurrentTasks = await getStoryTasks(story.project, story.slug);
  const todoTasks = allCurrentTasks.filter((t) => t.status === 'Todo');

  if (todoTasks.length > 0) {
    for (const task of todoTasks) {
      try {
        await runTask(task, story, notifier, repoPath);
      } catch (error) {
        console.error(`[runner] task execution error, continuing: ${task.slug}`, error);
      }
    }
  }

  // 全タスクの最新状態を取得してストーリー完了判定
  const terminalStatuses: TaskStatus[] = ['Done', 'Skipped', 'Failed'];
  const allTasks = todoTasks.length > 0
    ? await getStoryTasks(story.project, story.slug)
    : allCurrentTasks;
  const allTerminal = allTasks.length > 0 && allTasks.every((t) => terminalStatuses.includes(t.status));
  const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === 'Done');
  if (allDone) {
    updateFileStatus(story.filePath, 'Done');
    await notifier.notify(`✅ ストーリー完了: ${story.slug}`);
    console.log(`[runner] story done: ${story.slug}`);
  } else if (allTerminal) {
    updateFileStatus(story.filePath, 'Done');
    const summary = allTasks.map((t) => `${t.slug}(${t.status})`).join(', ');
    await notifier.notify(`✅ ストーリー完了 (一部スキップ/失敗あり): ${story.slug}\n${summary}`);
    console.log(`[runner] story done with skipped/failed tasks: ${story.slug}, ${summary}`);
  } else if (todoTasks.length === 0) {
    const remaining = allTasks.filter((t) => !terminalStatuses.includes(t.status));
    console.log(
      `[runner] no todo tasks but story not complete: ${story.slug}, ` +
      `remaining: ${remaining.map((t) => `${t.slug}(${t.status})`).join(', ')}`,
    );
  } else {
    const remaining = allTasks.filter((t) => !terminalStatuses.includes(t.status));
    console.log(`[runner] story not done, remaining tasks: ${remaining.map((t) => t.slug).join(', ')}`);
  }
}
