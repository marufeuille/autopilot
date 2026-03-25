import { StoryFile, TaskFile, TaskStatus } from './vault/reader';
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

export { RunnerDeps, createDefaultRunnerDeps } from './runner-deps';

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
): Promise<void> {
  let retryReason: string | undefined;

  while (true) {
    console.log(`[runner] decomposing story: ${story.slug}`);
    const drafts = await deps.decomposeTasks(story, retryReason);

    const id = generateApprovalId(story.slug, 'decompose');
    const result = await notifier.requestApproval(
      id,
      formatDecompositionMessage(story, drafts),
      { approve: '承認', reject: 'やり直し' },
      story.slug,
    );

    if (result.action === 'approve') {
      for (const draft of drafts) {
        deps.createTaskFile(story.project, story.slug, draft);
        console.log(`[runner] task file created: ${draft.slug}`);
      }
      return;
    }

    retryReason = result.reason;
    console.log(`[runner] decomposition rejected, retrying: ${retryReason}`);
  }
}

/**
 * README 更新を試行し、結果に応じて通知を送る共通ヘルパー。
 * リモートがない場合は何もしない。
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
      await notifier.notify(
        `ℹ️ README 更新不要と判断しました: \`${story.slug}\``,
        story.slug,
      );
    } else {
      await notifier.notify(
        `📝 *README 更新 PR 作成*: \`${story.slug}\`\n*PR*: ${docResult.prUrl}\nレビューをお願いします。`,
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
    await runDecomposition(story, notifier, d);
  }

  const allCurrentTasks = await d.getStoryTasks(story.project, story.slug);
  const todoTasks = allCurrentTasks.filter((t) => t.status === 'Todo');

  if (todoTasks.length > 0) {
    for (const task of todoTasks) {
      try {
        await runTask(task, story, notifier, repoPath, d);
      } catch (error) {
        console.error(`[runner] task execution error, continuing: ${task.slug}`, error);
      }
    }
  }

  // 全タスクの最新状態を取得してストーリー完了判定
  const terminalStatuses: TaskStatus[] = ['Done', 'Skipped', 'Failed'];
  const allTasks = todoTasks.length > 0
    ? await d.getStoryTasks(story.project, story.slug)
    : allCurrentTasks;
  const allTerminal = allTasks.length > 0 && allTasks.every((t) => terminalStatuses.includes(t.status));
  const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === 'Done');

  if (allDone) {
    // 全タスク Done → README 更新を試みてからストーリーを Done にする
    await tryDocUpdateAndNotify(story, allTasks, repoPath, notifier, d);

    d.updateFileStatus(story.filePath, 'Done');
    await notifier.notify(`✅ ストーリー完了: ${story.slug}`, story.slug);
    console.log(`[runner] story done: ${story.slug}`);
  } else if (allTerminal) {
    // 一部 Skipped/Failed あり → Done タスクがあれば README 更新を試みる
    const doneTasks = allTasks.filter((t) => t.status === 'Done');
    if (doneTasks.length > 0) {
      await tryDocUpdateAndNotify(story, doneTasks, repoPath, notifier, d);
    }

    d.updateFileStatus(story.filePath, 'Done');
    const summary = allTasks.map((t) => `${t.slug}(${t.status})`).join(', ');
    await notifier.notify(`✅ ストーリー完了 (一部スキップ/失敗あり): ${story.slug}\n${summary}`, story.slug);
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

  // スレッドセッション終了: メモリを解放
  notifier.endSession(story.slug);
  console.log(`[runner] thread session ended for story: ${story.slug}`);
}
