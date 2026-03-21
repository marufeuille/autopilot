import { Worker } from '@temporalio/worker';
import { sendApprovalMessage } from './activities/slack';
import { updateTaskStatusActivity, readTaskActivity } from './activities/vault';
import { config } from './config';

export async function createWorker(): Promise<Worker> {
  return Worker.create({
    workflowsPath: require.resolve('./workflows/task-workflow'),
    activities: {
      sendApprovalMessage,
      updateTaskStatusActivity,
      readTaskActivity,
    },
    taskQueue: config.temporal.taskQueue,
  });
}
