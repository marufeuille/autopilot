import { Worker } from '@temporalio/worker';
import * as vaultActivities from './activities/vault';
import * as slackActivities from './activities/slack';
import { config } from './config';

export async function createWorker(): Promise<Worker> {
  return Worker.create({
    workflowsPath: require.resolve('./workflows/index'),
    activities: {
      ...vaultActivities,
      sendTaskStartApproval: slackActivities.sendTaskStartApproval,
      sendTaskDoneApproval: slackActivities.sendTaskDoneApproval,
      sendStoryDoneNotification: slackActivities.sendStoryDoneNotification,
    },
    taskQueue: config.temporal.taskQueue,
  });
}
