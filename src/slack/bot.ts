import { App } from '@slack/bolt';
import { Client } from '@temporalio/client';
import { taskStartSignal, taskDoneSignal } from '../workflows/task-workflow';
import { config } from '../config';

export function createSlackApp(): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });
}

export function registerApprovalHandlers(app: App, temporalClient: Client): void {
  // タスク開始：承認
  app.action('task_start_approve', async ({ body, ack }) => {
    await ack();
    const workflowId = (body as any).actions[0].value as string;
    await temporalClient.workflow.getHandle(workflowId).signal(taskStartSignal, { action: 'approve' });
  });

  // タスク開始：スキップ
  app.action('task_start_skip', async ({ body, ack }) => {
    await ack();
    const workflowId = (body as any).actions[0].value as string;
    await temporalClient.workflow.getHandle(workflowId).signal(taskStartSignal, { action: 'skip' });
  });

  // タスク完了：承認
  app.action('task_done_approve', async ({ body, ack }) => {
    await ack();
    const workflowId = (body as any).actions[0].value as string;
    await temporalClient.workflow.getHandle(workflowId).signal(taskDoneSignal, { action: 'approve' });
  });

  // タスク完了：やり直し
  app.action('task_done_reject', async ({ body, ack }) => {
    await ack();
    const workflowId = (body as any).actions[0].value as string;
    await temporalClient.workflow.getHandle(workflowId).signal(taskDoneSignal, { action: 'reject' });
  });
}
