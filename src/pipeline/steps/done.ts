import { FlowSignal, TaskContext } from '../types';

/**
 * タスク完了 step
 *
 * ファイルステータスを Done に更新し、完了通知を送る。
 * 常に continue を返す（pipelineが終端に達し 'done' になる）。
 */
export async function handleDone(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, notifier, deps } = ctx;

  deps.updateFileStatus(task.filePath, 'Done');

  const localOnly = ctx.get('localOnly') as boolean | undefined;
  if (localOnly) {
    const commitSha = ctx.get('commitSha') as string | undefined;
    await notifier.notify(
      `✅ タスク完了（ローカルオンリー）: ${task.slug}\nコミットSHA: ${commitSha ?? 'unknown'}\nPRなし・ローカルコミットのみ`,
      story.slug,
    );
  } else {
    await notifier.notify(`✅ タスク完了: ${task.slug}`, story.slug);
  }

  return { kind: 'continue' };
}
