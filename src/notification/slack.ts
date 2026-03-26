import { App } from '@slack/bolt';
import type { BlockAction, ButtonAction } from '@slack/bolt';
import type { Block, KnownBlock, Button, ActionsBlock } from '@slack/types';
import { config } from '../config';
import type { NotificationBackend, ApprovalResult, NotifyOptions, TaskFailureAction, QueueFailedAction, AcceptanceCheckResult, AcceptanceGateAction } from './types';
import { buildRejectModal, buildTaskFailureBlocks, buildQueueFailedBlocks, buildAcceptanceGateBlocks, buildAcceptanceCommentModal } from './message-builder';
import { generateApprovalId } from './approval-id';
import { signalRejection } from '../merge/rejection-registry';
import { logError, logWarn } from '../logger';
import { ThreadSessionManager } from './thread-session';

/** メッセージ更新に必要な共通フィールド */
interface PendingMessage {
  channel: string;
  ts: string;
  message: string;
}

interface PendingApproval extends PendingMessage {
  resolve: (result: ApprovalResult) => void;
  originalBlocks: (Block | KnownBlock)[];
}

interface PendingTaskFailure extends PendingMessage {
  resolve: (action: TaskFailureAction) => void;
  originalBlocks: (Block | KnownBlock)[];
}

interface PendingAcceptanceGate extends PendingMessage {
  resolve: (action: AcceptanceGateAction) => void;
  originalBlocks: (Block | KnownBlock)[];
}

interface PendingQueueFailed extends PendingMessage {
  resolve: (action: QueueFailedAction) => void;
  originalBlocks: (Block | KnownBlock)[];
}

const pending = new Map<string, PendingApproval>();
const pendingTaskFailure = new Map<string, PendingTaskFailure>();
const pendingAcceptanceGate = new Map<string, PendingAcceptanceGate>();
const pendingQueueFailed = new Map<string, PendingQueueFailed>();

function buildApprovalBlocks(
  id: string,
  message: string,
  buttons: { approve: string; reject: string; cancel?: string },
): (Block | KnownBlock)[] {
  const elements: Button[] = [
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
  ];
  if (buttons.cancel) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: buttons.cancel },
      style: 'danger',
      action_id: 'cwk_cancel',
      value: id,
    });
  }
  const actionsBlock: ActionsBlock = {
    type: 'actions',
    elements,
  };
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: message },
    },
    actionsBlock,
  ];
}

async function updateMessageWithResult(
  app: App,
  entry: PendingMessage,
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
  app.action<BlockAction<ButtonAction>>('cwk_approve', async ({ body, ack }) => {
    await ack();
    const action = body.actions[0];
    const id = action.value as string;
    const label = action.text?.text ?? '承認';
    const entry = pending.get(id);
    if (entry) await updateMessageWithResult(app, entry, `✅ ${label}`);
    resolveApproval(id, { action: 'approve' });
  });

  // キャンセルボタン: メッセージを更新してすぐ解決
  app.action<BlockAction<ButtonAction>>('cwk_cancel', async ({ body, ack }) => {
    await ack();
    const action = body.actions[0];
    const id = action.value as string;
    const label = action.text?.text ?? 'キャンセル';
    const entry = pending.get(id);
    if (!entry) return;
    await updateMessageWithResult(app, entry, `🚫 ${label}`);
    resolveApproval(id, { action: 'cancel' });
  });

  // 却下ボタン: ボタンをすぐ消してからモーダルを開く
  app.action<BlockAction<ButtonAction>>('cwk_reject', async ({ body, ack, client }) => {
    await ack();
    const id = body.actions[0].value as string;
    const entry = pending.get(id);
    if (entry) await updateMessageWithResult(app, entry, '⏳ やり直し理由を入力中...');
    await client.views.open({
      trigger_id: body.trigger_id,
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
  app.action<BlockAction<ButtonAction>>('pr_reject_ng', async ({ body, ack, client, respond }) => {
    await ack();
    try {
      const action = body.actions[0];
      if (typeof action?.value !== 'string' || action.value.length === 0) {
        logWarn('pr_reject_ng: actions が空または value がありません', { phase: 'pr_reject_ng' });
        return;
      }
      const triggerId = body.trigger_id;
      if (!triggerId) {
        logWarn('pr_reject_ng: trigger_id が取得できませんでした', { phase: 'pr_reject_ng' });
        await respond({ text: '⚠️ モーダルを開けませんでした。もう一度お試しください。', replace_original: false });
        return;
      }
      const prUrl = action.value;
      await client.views.open({
        trigger_id: triggerId,
        view: buildRejectModal(prUrl),
      });
    } catch (err) {
      logError('pr_reject_ng: モーダルの表示に失敗しました', { phase: 'pr_reject_ng' }, err);
      try {
        await respond({ text: '⚠️ モーダルの表示に失敗しました。もう一度お試しください。', replace_original: false });
      } catch {
        // respond が失敗してもログは既に出力済み
      }
    }
  });

  // モーダル送信: 却下理由を取得して RejectionRegistry にシグナル
  app.view('pr_reject_modal', async ({ ack, view }) => {
    // Slack は view_submission に対し 3 秒以内の ack を要求するため、先に ack する
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
      // 既に ack 済みのため、ack({response_action:'errors'}) は使えない。
      // エラーログのみ出力する（必要に応じて chat.postMessage で通知を追加可能）。
      logError('pr_reject_modal: 却下処理に失敗しました', { phase: 'pr_reject_modal' }, err);
    }
  });
}

/**
 * Task失敗時の Slack アクションハンドラーを登録する
 *
 * cwk_task_retry / cwk_task_skip / cwk_task_cancel の3つのボタンに対応し、
 * 各ボタン押下時に Promise を resolve して結果を返す。
 */
export function registerTaskFailureHandlers(app: App): void {
  // リトライボタン
  app.action<BlockAction<ButtonAction>>('cwk_task_retry', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingTaskFailure.get(id);
    if (entry) await updateMessageWithResult(app, entry, '🔄 リトライ');
    resolveTaskFailure(id, 'retry');
  });

  // スキップボタン
  app.action<BlockAction<ButtonAction>>('cwk_task_skip', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingTaskFailure.get(id);
    if (entry) await updateMessageWithResult(app, entry, '⏭️ スキップして次へ');
    resolveTaskFailure(id, 'skip');
  });

  // キャンセルボタン
  app.action<BlockAction<ButtonAction>>('cwk_task_cancel', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingTaskFailure.get(id);
    if (entry) await updateMessageWithResult(app, entry, '🚫 ストーリーをキャンセル');
    resolveTaskFailure(id, 'cancel');
  });
}

function resolveTaskFailure(id: string, action: TaskFailureAction): void {
  pendingTaskFailure.get(id)?.resolve(action);
  pendingTaskFailure.delete(id);
}

function resolveAcceptanceGate(id: string, action: AcceptanceGateAction): void {
  pendingAcceptanceGate.get(id)?.resolve(action);
  pendingAcceptanceGate.delete(id);
}

function resolveQueueFailed(id: string, action: QueueFailedAction): void {
  pendingQueueFailed.get(id)?.resolve(action);
  pendingQueueFailed.delete(id);
}

/**
 * キュー停止時の Slack アクションハンドラーを登録する
 *
 * cwk_queue_resume / cwk_queue_retry / cwk_queue_clear の3つのボタンに対応し、
 * 各ボタン押下時に Promise を resolve して結果を返す。
 */
export function registerQueueFailedHandlers(app: App): void {
  // スキップして次へボタン
  app.action<BlockAction<ButtonAction>>('cwk_queue_resume', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingQueueFailed.get(id);
    if (entry) await updateMessageWithResult(app, entry, '⏭️ スキップして次へ');
    resolveQueueFailed(id, 'resume');
  });

  // このStoryをリトライボタン
  app.action<BlockAction<ButtonAction>>('cwk_queue_retry', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingQueueFailed.get(id);
    if (entry) await updateMessageWithResult(app, entry, '🔄 このStoryをリトライ');
    resolveQueueFailed(id, 'retry');
  });

  // キューをすべてクリアボタン
  app.action<BlockAction<ButtonAction>>('cwk_queue_clear', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingQueueFailed.get(id);
    if (entry) await updateMessageWithResult(app, entry, '🗑️ キューをすべてクリア');
    resolveQueueFailed(id, 'clear');
  });
}

/**
 * 受け入れ条件ゲートの Slack アクションハンドラーを登録する
 *
 * cwk_acceptance_done / cwk_acceptance_force_done / cwk_acceptance_comment の
 * 3つのボタンとコメント入力モーダルに対応する。
 */
export function registerAcceptanceGateHandlers(app: App): void {
  // Done ボタン（全条件PASS時）
  app.action<BlockAction<ButtonAction>>('cwk_acceptance_done', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingAcceptanceGate.get(id);
    if (entry) await updateMessageWithResult(app, entry, '⏳ Story を Done にしています...');
    resolveAcceptanceGate(id, { action: 'done', messageTs: entry?.ts });
  });

  // このまま Done にするボタン（一部FAIL時）
  app.action<BlockAction<ButtonAction>>('cwk_acceptance_force_done', async ({ body, ack }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const entry = pendingAcceptanceGate.get(id);
    if (entry) await updateMessageWithResult(app, entry, '⏳ Story を Done にしています...');
    resolveAcceptanceGate(id, { action: 'force_done', messageTs: entry?.ts });
  });

  // コメントして追加タスクを作るボタン → モーダルを開く
  app.action<BlockAction<ButtonAction>>('cwk_acceptance_comment', async ({ body, ack, client }) => {
    await ack();
    const metadata = JSON.parse(body.actions[0].value as string);
    const id = metadata.id;
    const storySlug = metadata.storySlug;
    const entry = pendingAcceptanceGate.get(id);
    if (entry) await updateMessageWithResult(app, entry, '⏳ コメントを入力中...');
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildAcceptanceCommentModal(id, storySlug),
    });
  });

  // コメントモーダル送信
  app.view('cwk_acceptance_comment_modal', async ({ ack, view }) => {
    await ack();
    const { id } = JSON.parse(view.private_metadata);
    const comment = view.state.values['comment_block']['comment_input'].value ?? '';
    const entry = pendingAcceptanceGate.get(id);
    if (entry) await updateMessageWithResult(app, entry, `💬 コメント: ${comment}`);
    resolveAcceptanceGate(id, { action: 'comment', text: comment });
  });

  // コメントモーダルキャンセル → 元のボタンを復元し、pending を解放しない（ボタン再押下を許可）
  app.view({ callback_id: 'cwk_acceptance_comment_modal', type: 'view_closed' }, async ({ ack, view }) => {
    await ack();
    const { id } = JSON.parse(view.private_metadata);
    const entry = pendingAcceptanceGate.get(id);
    if (!entry) return;
    // originalBlocks を復元してボタンを再表示する
    // ユーザーは再度ボタンを押して別のアクションを選択できる
    try {
      await app.client.chat.update({
        channel: entry.channel,
        ts: entry.ts,
        blocks: entry.originalBlocks,
        text: '',
      });
    } catch {
      // メッセージ更新に失敗した場合は pending を解放して処理を終了する
      resolveAcceptanceGate(id, { action: 'comment', text: '' });
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

  async notifyUpdate(messageTs: string, message: string, storySlug?: string): Promise<void> {
    await this.app.client.chat.update({
      channel: config.slack.channelId,
      ts: messageTs,
      text: message,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: message } },
      ],
    });
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
    buttons: { approve: string; reject: string; cancel?: string },
    storySlug?: string,
  ): Promise<ApprovalResult> {
    return this._postApprovalRequest(id, message, buttons, storySlug);
  }

  async requestTaskFailureAction(
    taskSlug: string,
    storySlug: string,
    errorSummary: string,
  ): Promise<TaskFailureAction> {
    const id = generateApprovalId(storySlug, `failure-${taskSlug}`);
    const threadTs = this.threadSession.getThreadTs(storySlug);
    const message =
      `❌ *タスク失敗*: \`${taskSlug}\`\n` +
      `*ストーリー*: \`${storySlug}\`\n` +
      `*エラー*: ${errorSummary}\n\n` +
      `対応を選択してください。`;
    const blocks = buildTaskFailureBlocks(id, taskSlug, storySlug, errorSummary);

    const res = await this.app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: message,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    return new Promise((resolve) =>
      pendingTaskFailure.set(id, {
        resolve,
        channel: config.slack.channelId,
        ts: res.ts as string,
        message,
        originalBlocks: blocks,
      }),
    );
  }

  async requestQueueFailedAction(
    storySlug: string,
    message: string,
  ): Promise<QueueFailedAction> {
    const id = generateApprovalId(storySlug, 'queue-failed');
    const threadTs = this.threadSession.getThreadTs(storySlug);
    const blocks = buildQueueFailedBlocks(id, storySlug, message);

    const res = await this.app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: message,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    return new Promise((resolve) =>
      pendingQueueFailed.set(id, {
        resolve,
        channel: config.slack.channelId,
        ts: res.ts as string,
        message,
        originalBlocks: blocks,
      }),
    );
  }

  async requestAcceptanceGateAction(
    storySlug: string,
    checkResult: AcceptanceCheckResult,
  ): Promise<AcceptanceGateAction> {
    const id = generateApprovalId(storySlug, 'acceptance-gate');
    const threadTs = this.threadSession.getThreadTs(storySlug);
    const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);

    const headerIcon = checkResult.allPassed ? '✅' : '⚠️';
    const message = `${headerIcon} 受け入れ条件チェック結果: \`${storySlug}\``;

    const res = await this.app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: message,
      blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });

    return new Promise((resolve) =>
      pendingAcceptanceGate.set(id, {
        resolve,
        channel: config.slack.channelId,
        ts: res.ts as string,
        message,
        originalBlocks: blocks,
      }),
    );
  }

  /** 承認リクエストを Slack に投稿し、結果を待つ */
  private async _postApprovalRequest(
    id: string,
    message: string,
    buttons: { approve: string; reject: string; cancel?: string },
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
