import { proxyActivities, setHandler, condition, defineSignal } from '@temporalio/workflow';
import type { ApprovalMessageParams } from '../activities/slack';
import type { TaskFile } from '../vault/reader';

const { sendApprovalMessage, updateTaskStatusActivity, readTaskActivity } = proxyActivities<{
  sendApprovalMessage(params: ApprovalMessageParams): Promise<void>;
  updateTaskStatusActivity(filePath: string, status: string): Promise<void>;
  readTaskActivity(filePath: string): Promise<TaskFile>;
}>({
  startToCloseTimeout: '10 minutes',
});

export const approvalSignal = defineSignal<[{ decision: 'approve' | 'reject' }]>('approval');

export interface TaskWorkflowParams {
  filePath: string;
  project: string;
  taskSlug: string;
  story: string;
}

export async function taskWorkflow(params: TaskWorkflowParams): Promise<string> {
  const { filePath, project, taskSlug, story } = params;
  const workflowId = taskSlug;

  let decision: 'approve' | 'reject' | null = null;

  setHandler(approvalSignal, (payload) => {
    decision = payload.decision;
  });

  // Slack に承認依頼を送信
  await sendApprovalMessage({ workflowId, taskSlug, project, story, filePath });

  // 承認または却下が来るまで待機
  await condition(() => decision !== null);

  const newStatus = decision === 'approve' ? 'approved' : 'rejected';
  await updateTaskStatusActivity(filePath, newStatus);

  return newStatus;
}
