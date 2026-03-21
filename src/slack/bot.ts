import { App } from '@slack/bolt';
import { Client } from '@temporalio/client';
import { approvalSignal } from '../workflows/task-workflow';
import { config } from '../config';

export function createSlackApp(): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });
}

export function registerApprovalHandlers(app: App, temporalClient: Client): void {
  app.action('approve', async ({ body, ack }) => {
    await ack();
    const workflowId = (body as any).actions[0].value as string;
    const handle = temporalClient.workflow.getHandle(workflowId);
    await handle.signal(approvalSignal, { decision: 'approve' });
  });

  app.action('reject', async ({ body, ack }) => {
    await ack();
    const workflowId = (body as any).actions[0].value as string;
    const handle = temporalClient.workflow.getHandle(workflowId);
    await handle.signal(approvalSignal, { decision: 'reject' });
  });
}
