import { App } from '@slack/bolt';
import { config } from './config';

export type ApprovalResult =
  | { action: 'approve' }
  | { action: 'reject'; reason: string };

interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
  channel: string;
  ts: string;
}

const pending = new Map<string, PendingApproval>();

export function generateApprovalId(storySlug: string, taskSlug: string): string {
  return `${storySlug}--${taskSlug}--${Date.now()}`;
}

export async function requestApproval(
  app: App,
  id: string,
  message: string,
  buttons: { approve: string; reject: string },
): Promise<ApprovalResult> {
  const res = await app.client.chat.postMessage({
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

  return new Promise((resolve) =>
    pending.set(id, {
      resolve,
      channel: config.slack.channelId,
      ts: res.ts as string,
    }),
  );
}

async function updateOriginalMessage(app: App, id: string, text: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry) return;
  await app.client.chat.update({
    channel: entry.channel,
    ts: entry.ts,
    text,
    blocks: [],
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
    await updateOriginalMessage(app, id, `✅ ${label}`);
    resolveApproval(id, { action: 'approve' });
  });

  // 却下ボタン: モーダルを開いて理由を入力させる
  app.action('cwk_reject', async ({ body, ack, client }) => {
    await ack();
    const id = (body as any).actions[0].value as string;
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'cwk_reject_modal',
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
  app.view('cwk_reject_modal', async ({ ack, view, client }) => {
    await ack();
    const id = view.private_metadata;
    const reason = view.state.values['reason_block']['reason_input'].value ?? '';
    await updateOriginalMessage(app, id, `🚫 やり直し: ${reason}`);
    resolveApproval(id, { action: 'reject', reason });
  });
}
