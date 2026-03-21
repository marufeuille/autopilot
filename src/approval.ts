import { App } from '@slack/bolt';
import type { Block, KnownBlock } from '@slack/types';
import { config } from './config';
import type { NotificationBackend, ApprovalResult } from './notification';

export type { ApprovalResult };

interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
  channel: string;
  ts: string;
  message: string;
  originalBlocks: (Block | KnownBlock)[];
}

const pending = new Map<string, PendingApproval>();

export function generateApprovalId(storySlug: string, taskSlug: string): string {
  return `${storySlug}--${taskSlug}--${Date.now()}`;
}

function buildApprovalBlocks(
  id: string,
  message: string,
  buttons: { approve: string; reject: string },
): (Block | KnownBlock)[] {
  return [
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
  ];
}

export async function requestApproval(
  app: App,
  id: string,
  message: string,
  buttons: { approve: string; reject: string },
): Promise<ApprovalResult> {
  const blocks = buildApprovalBlocks(id, message, buttons);
  const res = await app.client.chat.postMessage({
    channel: config.slack.channelId,
    blocks,
  });

  return new Promise((resolve) =>
    pending.set(id, {
      resolve,
      channel: config.slack.channelId,
      ts: res.ts as string,
      message,
      originalBlocks: blocks,
    }),
  );
}

async function updateMessageWithResult(
  app: App,
  entry: PendingApproval,
  resultText: string,
): Promise<void> {
  await app.client.chat.update({
    channel: entry.channel,
    ts: entry.ts,
    text: resultText,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: entry.message } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: resultText } },
    ],
  });
}

async function restoreOriginalMessage(app: App, id: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  await app.client.chat.update({
    channel: entry.channel,
    ts: entry.ts,
    blocks: entry.originalBlocks,
    text: '',
  });
}

function resolveApproval(id: string, result: ApprovalResult): void {
  pending.get(id)?.resolve(result);
  pending.delete(id);
}

export function registerApprovalHandlers(app: App): void {
  // 承認ボタン: メッセージを更新してすぐ解決
  app.action('cwk_approve', async ({ body, ack }) => {
    await ack();
    const action = (body as any).actions[0];
    const id = action.value as string;
    const label = action.text?.text ?? '承認';
    const entry = pending.get(id);
    if (entry) await updateMessageWithResult(app, entry, `✅ ${label}`);
    resolveApproval(id, { action: 'approve' });
  });

  // 却下ボタン: ボタンをすぐ消してからモーダルを開く
  app.action('cwk_reject', async ({ body, ack, client }) => {
    await ack();
    const id = (body as any).actions[0].value as string;
    const entry = pending.get(id);
    if (entry) await updateMessageWithResult(app, entry, '⏳ やり直し理由を入力中...');
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'cwk_reject_modal',
        notify_on_close: true,
        private_metadata: id,
        title: { type: 'plain_text', text: 'やり直し理由' },
        submit: { type: 'plain_text', text: '送信' },
        close: { type: 'plain_text', text: 'キャンセル' },
        blocks: [
          {
            type: 'input',
            block_id: 'reason_block',
            element: {
              type: 'plain_text_input',
              action_id: 'reason_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: '修正してほしい内容を入力してください',
              },
            },
            label: { type: 'plain_text', text: '理由' },
          },
        ],
      },
    });
  });

  // モーダル送信: 理由を取得してメッセージ更新 + 解決
  app.view('cwk_reject_modal', async ({ ack, view }) => {
    await ack();
    const id = view.private_metadata;
    const reason = view.state.values['reason_block']['reason_input'].value ?? '';
    const entry = pending.get(id);
    if (entry) await updateMessageWithResult(app, entry, `🚫 やり直し: ${reason}`);
    resolveApproval(id, { action: 'reject', reason });
  });

  // モーダルキャンセル: 元のボタンを復元
  app.view({ callback_id: 'cwk_reject_modal', type: 'view_closed' }, async ({ ack, view }) => {
    await ack();
    const id = view.private_metadata;
    await restoreOriginalMessage(app, id);
  });
}

/**
 * Slack バックエンドを NotificationBackend インターフェースでラップするアダプター
 */
export class SlackNotificationBackend implements NotificationBackend {
  constructor(private readonly app: App) {}

  async notify(message: string): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: message,
    });
  }

  requestApproval(
    id: string,
    message: string,
    buttons: { approve: string; reject: string },
  ): Promise<ApprovalResult> {
    return requestApproval(this.app, id, message, buttons);
  }
}
