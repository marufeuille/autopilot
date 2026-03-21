import { App } from '@slack/bolt';
import { config } from './config';

export type ApprovalResult = 'approve' | 'reject';

const pending = new Map<string, (result: ApprovalResult) => void>();

export function generateApprovalId(storySlug: string, taskSlug: string): string {
  return `${storySlug}--${taskSlug}--${Date.now()}`;
}

export async function requestApproval(
  app: App,
  id: string,
  message: string,
  buttons: { approve: string; reject: string },
): Promise<ApprovalResult> {
  await app.client.chat.postMessage({
    channel: config.slack.channelId,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: message },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: buttons.approve },
            style: 'primary',
            action_id: 'cwk_approve',
            value: id,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: buttons.reject },
            style: 'danger',
            action_id: 'cwk_reject',
            value: id,
          },
        ],
      },
    ],
  });

  return new Promise((resolve) => pending.set(id, resolve));
}

export function resolveApproval(id: string, result: ApprovalResult): void {
  pending.get(id)?.(result);
  pending.delete(id);
}

export function registerApprovalHandlers(app: App): void {
  app.action('cwk_approve', async ({ body, ack }) => {
    await ack();
    const id = (body as any).actions[0].value as string;
    resolveApproval(id, 'approve');
  });

  app.action('cwk_reject', async ({ body, ack }) => {
    await ack();
    const id = (body as any).actions[0].value as string;
    resolveApproval(id, 'reject');
  });
}
