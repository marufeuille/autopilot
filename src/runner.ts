import { StoryFile, StoryStatus, TaskFile, TaskStatus } from './vault/reader';
import { TaskDraft } from './vault/writer';
import {
  NotificationBackend,
  generateApprovalId,
  buildThreadOriginMessage,
} from './notification';
import { GitSyncError, detectNoRemote } from './git';
import { resolveRepoPath } from './config';
import { RunnerDeps, createDefaultRunnerDeps } from './runner-deps';
import { createTaskContext } from './pipeline/runner';
import { taskPipeline } from './pipeline/task-pipeline';
import { runStoryDocUpdate } from './story-doc-update';
import { runMergePollingLoop } from './merge';

export { RunnerDeps, createDefaultRunnerDeps } from './runner-deps';

/** Task失敗時のユーザー選択肢 */
export type TaskFailureAction = 'retry' | 'skip' | 'cancel';

/**
 * Task失敗時にSlackのストーリースレッドへボタン付き通知を送信し、
 * ユーザーの選択（リトライ/スキップ/キャンセル）を待つ。
 *
 * 既存の requestApproval インターフェースを再利用する:
 * - approve → retry（リトライ）
 * - reject  → skip（スキップして次へ）
 * - cancel  → cancel（ストーリーをキャンセル）
 */
export async function requestTaskFailureAction(
  task: TaskFile,
  story: StoryFile,
  notifier: NotificationBackend,
  error: unknown,
): Promise<TaskFailureAction> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const id = generateApprovalId(story.slug, `failure-${task.slug}`);
  const message =
    `❌ *タスク失敗*: \`${task.slug}\`\n` +
    `*ストーリー*: \`${story.slug}\`\n` +
    `*エラー*: ${errorMessage}\n\n` +
    `対応を選択してください。`;

  const result = await notifier.requestApproval(
    id,
    message,
    { approve: '\u30EA\u30C8\u30E9\u30A4', reject: '\u30B9\u30AD\u30C3\u30D7\u3057\u3066\u6B21\u3078', cancel: '\u30B9\u30C8\u30FC\u30EA\u30FC\u3092\u30AD\u30E3\u30F3\u30BB\u30EB' },
    story.slug,
  );

  switch (result.action) {
    case 'approve':
      return 'retry';
    case 'reject':
      return 'skip';
    case 'cancel':
      return 'cancel';
    default:
      throw new Error(`Unexpected approval action: ${String((result as { action: unknown }).action)}`);
  }
}

export async function runTask(
  task: TaskFile,
  story: StoryFile,
  notifier: NotificationBackend,
  repoPath: string,
  deps?: RunnerDeps,
): Promise<void> {
  const d = deps ?? createDefaultRunnerDeps();
  const ctx = createTaskContext({ task, story, repoPath, notifier, deps: d });

  try {
    const result = await taskPipeline(ctx);
    if (result === 'skipped') {
      d.updateFileStatus(task.filePath, 'Skipped');
    }
  } catch (error) {
    d.updateFileStatus(task.filePath, 'Failed');
    if (error instanceof GitSyncError) {
      return;
    }
    throw error;
  }
}

function formatDecompositionMessage(story: StoryFile, drafts: TaskDraft[]): string {
  const list = drafts
    .map((d, i) => `${i + 1}. *${d.title}* (\`${d.slug}\`)\n   ${d.purpose}`)
    .join('\n');
  return `*タスク分解案*\n\n*ストーリー*: ${story.slug}\n\n${list}\n\n承認するとタスクファイルを作成して実行を開始します。`;
}

async function runDecomposition(
  story: StoryFile,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<'approved' | 'cancelled'> {
  let retryReason: string | undefined;

  while (true) {
    console.log(`[runner] decomposing story: ${story.slug}`);
    const drafts = await deps.decomposeTasks(story, retryReason);

    const id = generateApprovalId(story.slug, 'decompose');
    const result = await notifier.requestApproval(
      id,
      formatDecompositionMessage(story, drafts),
      { approve: '承認', reject: 'やり直し', cancel: 'キャンセル' },
      story.slug,
    );

    if (result.action === 'approve') {
      for (const draft of drafts) {
        deps.createTaskFile(story.project, story.slug, draft);
        console.log(`[runner] task file created: ${draft.slug}`);
      }
      return 'approved';
    }

    if (result.action === 'cancel') {
      deps.updateFileStatus(story.filePath, 'Cancelled');
      await notifier.notify(`🚫 ストーリーがキャンセルされました: ${story.slug}`, story.slug);
      console.log(`[runner] story cancelled: ${story.slug}`);
      return 'cancelled';
    }

    retryReason = result.reason;
    console.log(`[runner] decomposition rejected, retrying: ${retryReason}`);
  }
}

/**
 * README 更新を試行し、結果に応じて通知を送る共通ヘルパー。
 * リモートがない場合は何もしない。
 * PR が作成された場合はマージされるまでポーリングで待機する。
 */
async function tryDocUpdateAndNotify(
  story: StoryFile,
  tasks: TaskFile[],
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<void> {
  if (detectNoRemote(repoPath)) return;

  try {
    const docResult = await runStoryDocUpdate(story, tasks, repoPath, notifier, deps);
    if (docResult.skipped) {
      const reason = docResult.skipReason ?? '更新不要';
      await notifier.notify(
        `ℹ️ *README 更新スキップ*: \`${story.slug}\`\n*理由*: ${reason}`,
        story.slug,
      );
      return;
    }

    // PR 作成成功 → レビュー通知を送信し、マージを待機する
    await notifier.notify(
      `📝 *README 更新 PR 作成*: \`${story.slug}\`\n*PR*: ${docResult.prUrl}\nレビュー・マージをお願いします。`,
      story.slug,
    );

    // マージポーリングで待機（pr-lifecycle と同じ仕組み）
    const mergeResult = await runMergePollingLoop(
      docResult.prUrl!,
      repoPath,
      { execGh: deps.execGh },
    );

    if (mergeResult.finalStatus === 'merged') {
      console.log(`[runner] doc PR merged: ${docResult.prUrl}`);
      await notifier.notify(
        `✅ *README 更新 PR マージ完了*: \`${story.slug}\`\n*PR*: ${docResult.prUrl}`,
        story.slug,
      );
    } else {
      // closed / timeout / error / rejected — いずれも致命的ではないのでログ＋通知のみ
      console.warn(`[runner] doc PR not merged (${mergeResult.finalStatus}): ${docResult.prUrl}`);
      await notifier.notify(
        `⚠️ *README 更新 PR 未マージ* (${mergeResult.finalStatus}): \`${story.slug}\`\n*PR*: ${docResult.prUrl}`,
        story.slug,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[runner] story doc update failed: ${message}`);
    await notifier.notify(
      `⚠️ *README 更新失敗* (${story.slug}): ${message}\nストーリー完了処理は続行します。`,
      story.slug,
    ).catch(() => {});
  }
}

/**
 * 全タスクのステータスからストーリーの最終ステータスを算出する。
 * 優先度: Cancelled > Failed > Done
 * - Cancelled タスクが1つ以上 → Cancelled
 * - Failed タスクが1つ以上 → Failed
 * - 全タスクが Done or Skipped → Done
 *
 * 前提条件: 全タスクが終端ステータス（Done/Skipped/Failed/Cancelled）であること。
 * 非終端ステータス（Todo/Doing）のタスクが含まれている場合は Error をスローする。
 *
 * @param tasks タスク配列。空配列の場合は 'Done' を返す。
 * @throws {Error} 非終端ステータスのタスクが含まれている場合
 */
export function deriveStoryStatus(tasks: TaskFile[]): StoryStatus {
  if (tasks.length === 0) return 'Done';

  const terminalStatuses: TaskStatus[] = ['Done', 'Skipped', 'Failed', 'Cancelled'];
  const nonTerminal = tasks.filter((t) => !terminalStatuses.includes(t.status));
  if (nonTerminal.length > 0) {
    const details = nonTerminal.map((t) => `${t.slug}(${t.status})`).join(', ');
    throw new Error(`deriveStoryStatus: non-terminal tasks found: ${details}`);
  }

  if (tasks.some((t) => t.status === 'Cancelled')) return 'Cancelled';
  if (tasks.some((t) => t.status === 'Failed')) return 'Failed';
  return 'Done';
}

export async function runStory(
  story: StoryFile,
  notifier: NotificationBackend,
  deps?: RunnerDeps,
): Promise<void> {
  const d = deps ?? createDefaultRunnerDeps();
  const repoPath = resolveRepoPath(story.project);
  console.log(`[runner] starting story: ${story.slug}`);

  const tasks = await d.getStoryTasks(story.project, story.slug);

  // スレッドセッション開始: 起点メッセージを投稿
  const originMessage = buildThreadOriginMessage(story.slug, tasks);
  await notifier.startThread(story.slug, originMessage);
  console.log(`[runner] thread session started for story: ${story.slug}`);

  if (tasks.length === 0) {
    const decompositionResult = await runDecomposition(story, notifier, d);
    if (decompositionResult === 'cancelled') {
      notifier.endSession(story.slug);
      console.log(`[runner] thread session ended for story: ${story.slug}`);
      return;
    }
  }

  const allCurrentTasks = await d.getStoryTasks(story.project, story.slug);
  const todoTasks = allCurrentTasks.filter((t) => t.status === 'Todo');

  if (todoTasks.length > 0) {
    let cancelled = false;
    let i = 0;
    while (i < todoTasks.length) {
      const task = todoTasks[i];
      let retryCount = 0;
      let succeeded = false;

      while (!succeeded) {
        try {
          await runTask(task, story, notifier, repoPath, d);
          succeeded = true;
        } catch (error) {
          console.error(`[runner] task failed: ${task.slug}`, error);

          const action = await requestTaskFailureAction(task, story, notifier, error);

          if (action === 'retry') {
            retryCount++;
            console.log(`[runner] retrying task: ${task.slug} (retry #${retryCount})`);
            await d.updateFileStatus(task.filePath, 'Todo');
            continue;
          } else if (action === 'skip') {
            console.log(`[runner] skipping task: ${task.slug}`);
            await d.updateFileStatus(task.filePath, 'Skipped');
            succeeded = true; // inner loop を抜けて次のタスクへ
          } else if (action === 'cancel') {
            console.log(`[runner] cancelling story: ${story.slug}`);
            await d.updateFileStatus(story.filePath, 'Cancelled');
            await notifier.notify(
              `🚫 ストーリーがキャンセルされました: ${story.slug}`,
              story.slug,
            );
            cancelled = true;
            succeeded = true; // inner loop を抜ける
          } else {
            const _exhaustive: never = action;
            throw new Error(`Unexpected task failure action: ${_exhaustive}`);
          }
        }
      }

      if (cancelled) break;
      i++;
    }

    if (cancelled) {
      notifier.endSession(story.slug);
      console.log(`[runner] thread session ended for story: ${story.slug}`);
      return;
    }
  }

  // 全タスクの最新状態を取得してストーリー完了判定
  const terminalStatuses: TaskStatus[] = ['Done', 'Skipped', 'Failed', 'Cancelled'];
  const allTasks = todoTasks.length > 0
    ? await d.getStoryTasks(story.project, story.slug)
    : allCurrentTasks;
  const allTerminal = allTasks.length > 0 && allTasks.every((t) => terminalStatuses.includes(t.status));

  if (allTerminal) {
    // Done タスクがあれば README 更新を試みる
    const doneTasks = allTasks.filter((t) => t.status === 'Done');
    if (doneTasks.length > 0) {
      await tryDocUpdateAndNotify(story, doneTasks, repoPath, notifier, d);
    }

    // ストーリーの最終ステータスを算出（優先度: Cancelled > Failed > Done）
    const storyStatus = deriveStoryStatus(allTasks);
    d.updateFileStatus(story.filePath, storyStatus);

    if (storyStatus === 'Done') {
      await notifier.notify(`✅ ストーリー完了: ${story.slug}`, story.slug);
      console.log(`[runner] story done: ${story.slug}`);
    } else {
      const summary = allTasks.map((t) => `${t.slug}(${t.status})`).join(', ');
      const icon = storyStatus === 'Cancelled' ? '🚫' : '❌';
      await notifier.notify(`${icon} ストーリー${storyStatus}: ${story.slug}\n${summary}`, story.slug);
      console.log(`[runner] story ${storyStatus}: ${story.slug}, ${summary}`);
    }
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

  // スレッドセッション終了: メモリを解放
  notifier.endSession(story.slug);
  console.log(`[runner] thread session ended for story: ${story.slug}`);
}
