import { App } from '@slack/bolt';
import type { BlockAction, ButtonAction } from '@slack/bolt';
import type { Block, KnownBlock } from '@slack/types';
import { config } from '../config';
import type { NotificationBackend, ApprovalResult, NotifyOptions } from './types';
import { buildRejectModal } from './message-builder';
import { signalRejection } from '../merge/rejection-registry';
import { logError, logWarn } from '../logger';
import { ThreadSessionManager } from './thread-session';

interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
  channel: string;
  ts: string;
  message: string;
  originalBlocks: (Block | KnownBlock)[];
}

const pending = new Map<string, PendingApproval>();

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

/**
 * Slack アクションハンドラーを登録する
 *
 * 承認ボタン、却下ボタン、却下理由モーダルのハンドラーを Slack App に登録する。
 */
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
 * PR 却下用の Slack アクションハンドラーを登録する
 *
 * 「マージ準備完了」通知の NG ボタンと却下理由入力モーダルのハンドラーを登録する。
 */
export function registerPRRejectHandlers(app: App): void {
  // NG ボタン: モーダルを開く
  app.action<BlockAction<ButtonAction>>('pr_reject_ng', async ({ body, ack, client }) => {
    await ack();
    try {
      const action = body.actions[0];
      if (!action?.value) {
        logWarn('pr_reject_ng: actions が空または value がありません', { phase: 'pr_reject_ng' });
        return;
      }
      const prUrl = action.value;
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildRejectModal(prUrl),
      });
    } catch (err) {
      logError('pr_reject_ng: モーダルの表示に失敗しました', { phase: 'pr_reject_ng' }, err);
    }
  });

  // モーダル送信: 却下理由を取得して RejectionRegistry にシグナル
  app.view('pr_reject_modal', async ({ ack, view }) => {
    await ack();
    try {
      const prUrl = view.private_metadata;
      const reason = view.state?.values?.['reason_block']?.['reason_input']?.value ?? '';
      const accepted = signalRejection(prUrl, reason);
      if (!accepted) {
        logWarn('pr_reject_modal: signalRejection が受理されませんでした（待機中エントリなし）', {
          phase: 'pr_reject_modal',
          prUrl,
        });
      }
    } catch (err) {
      logError('pr_reject_modal: 却下処理に失敗しました', { phase: 'pr_reject_modal' }, err);
    }
  });
}

/**
 * Slack 通知バックエンド
 *
 * NotificationBackend インターフェースを実装し、Slack API 経由で
 * 通知送信と承認フロー（インタラクティブボタン + モーダル）を提供する。
 */
export class SlackNotificationBackend implements NotificationBackend {
  private readonly threadSession = new ThreadSessionManager();

  constructor(private readonly app: App) {}

  async startThread(storySlug: string, message: string): Promise<void> {
    const res = await this.app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: message,
    });
    if (res.ts) {
      this.threadSession.startSession(storySlug, res.ts);
    }
  }

  getThreadTs(storySlug: string): string | undefined {
    return this.threadSession.getThreadTs(storySlug);
  }

  endSession(storySlug: string): void {
    this.threadSession.endSession(storySlug);
  }

  async notify(message: string, storySlug?: string, options?: NotifyOptions): Promise<void> {
    const threadTs = storySlug ? this.threadSession.getThreadTs(storySlug) : undefined;
    await this.app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: message,
      ...(options?.blocks ? { blocks: options.blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  requestApproval(
    id: string,
    message: string,
    buttons: { approve: string; reject: string },
    storySlug?: string,
  ): Promise<ApprovalResult> {
    return this._postApprovalRequest(id, message, buttons, storySlug);
  }

  /** 承認リクエストを Slack に投稿し、結果を待つ */
  private async _postApprovalRequest(
    id: string,
    message: string,
    buttons: { approve: string; reject: string },
    storySlug?: string,
  ): Promise<ApprovalResult> {
    const threadTs = storySlug ? this.threadSession.getThreadTs(storySlug) : undefined;
    const blocks = buildApprovalBlocks(id, message, buttons);
    const res = await this.app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: message,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
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
}
