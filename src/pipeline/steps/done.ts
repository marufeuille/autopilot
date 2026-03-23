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
  await notifier.notify(`✅ タスク完了: ${task.slug}`, story.slug);

  return { kind: 'continue' };
}
