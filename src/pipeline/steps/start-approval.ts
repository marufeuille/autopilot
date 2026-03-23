import { FlowSignal, TaskContext } from '../types';
import { generateApprovalId } from '../../notification/approval-id';

/**
 * タスク開始承認 step
 *
 * Slack でタスク開始の確認を取る。
 * - 承認 → continue
 * - スキップ → skip
 */
export async function handleStartApproval(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, notifier } = ctx;

  const id = generateApprovalId(story.slug, task.slug);
  const result = await notifier.requestApproval(
    id,
    `*タスク開始確認*\n\n*ストーリー*: ${story.slug}\n*タスク*: ${task.slug}\n\nこのタスクを開始しますか？`,
    { approve: '開始', reject: 'スキップ' },
    story.slug,
  );

  if (result.action === 'reject') {
    return { kind: 'skip' };
  }
  return { kind: 'continue' };
}
