import {
  proxyActivities,
  setHandler,
  condition,
  defineSignal,
  workflowInfo,
} from '@temporalio/workflow';
import type { TaskStartParams, TaskDoneParams } from '../activities/slack';
import type { TaskFile } from '../vault/reader';

const {
  sendTaskStartApproval,
  sendTaskDoneApproval,
  updateTaskStatusActivity,
} = proxyActivities<{
  sendTaskStartApproval(params: TaskStartParams): Promise<void>;
  sendTaskDoneApproval(params: TaskDoneParams): Promise<void>;
  updateTaskStatusActivity(filePath: string, status: string): Promise<void>;
}>({
  startToCloseTimeout: '10 minutes',
});

export const taskStartSignal = defineSignal<[{ action: 'approve' | 'skip' }]>('taskStart');
export const taskDoneSignal = defineSignal<[{ action: 'approve' | 'reject' }]>('taskDone');

export interface TaskWorkflowParams {
  task: TaskFile;
  project: string;
  storySlug: string;
}

export type TaskWorkflowResult = 'done' | 'skipped';

export async function taskWorkflow(params: TaskWorkflowParams): Promise<TaskWorkflowResult> {
  const { task, project, storySlug } = params;
  const workflowId = workflowInfo().workflowId;

  // --- Gate 1: タスク開始承認 ---
  let startAction: 'approve' | 'skip' | null = null;
  setHandler(taskStartSignal, (payload) => { startAction = payload.action; });

  await sendTaskStartApproval({ workflowId, taskSlug: task.slug, storySlug, project });
  await condition(() => startAction !== null);

  if (startAction === 'skip') {
    return 'skipped';
  }

  await updateTaskStatusActivity(task.filePath, 'Doing');

  // --- Gate 2: タスク完了確認 ---
  // （Story 1 では Claude 実装なし。Story 2 以降でここに Claude 実行を挟む）
  let doneAction: 'approve' | 'reject' | null = null;
  setHandler(taskDoneSignal, (payload) => { doneAction = payload.action; });

  while (true) {
    await sendTaskDoneApproval({ workflowId, taskSlug: task.slug, storySlug, project });
    await condition(() => doneAction !== null);

    if (doneAction === 'approve') break;
    // reject の場合は再度確認（Story 2 以降は Claude に修正依頼する）
    doneAction = null;
  }

  await updateTaskStatusActivity(task.filePath, 'Done');
  return 'done';
}
