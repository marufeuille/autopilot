/**
 * 通知バックエンドのファクトリ
 *
 * 環境変数 NOTIFY_BACKEND で切り替える。
 * - "local": macOS 通知 + ターミナル入力（デフォルト）
 * - "slack": Slack バックエンド
 * - 未設定: デフォルトは "local"
 */
export { NotificationBackend, ApprovalResult, NotificationEventType, NotificationContext } from './types';
export { LocalNotificationBackend } from './local';
export { SlackNotificationBackend } from './slack';
export { generateApprovalId } from './approval-id';
export { ResilientNotificationBackend, ResilientOptions } from './resilient';
export {
  buildNotificationMessage,
  buildMergeApprovalMessage,
  buildReviewEscalationMessage,
  buildCIEscalationMessage,
} from './message-builder';

import { NotificationBackend } from './types';
import { LocalNotificationBackend } from './local';
import { ResilientNotificationBackend } from './resilient';

/**
 * 環境変数 NOTIFY_BACKEND に基づいて適切な通知バックエンドを生成する。
 *
 * - "local"（デフォルト）: macOS システム通知 + ターミナル入力
 * - "slack": Slack ボット経由の通知・承認フロー（動的インポート）
 *
 * @throws 未知のバックエンド指定時にエラー
 */
export async function createNotificationBackend(): Promise<NotificationBackend> {
  const backend = process.env.NOTIFY_BACKEND ?? 'local';

  switch (backend) {
    case 'local':
      return new LocalNotificationBackend();

    case 'slack': {
      // Slack 依存を動的インポート（local 使用時は不要な依存を読み込まない）
      const { createSlackApp } = await import('../slack/bot');
      const { registerApprovalHandlers, SlackNotificationBackend } = await import('./slack');

      const slackApp = createSlackApp();
      registerApprovalHandlers(slackApp);
      await slackApp.start();
      console.log('[slack] bot started (Socket Mode)');

      const slackBackend = new SlackNotificationBackend(slackApp);
      // Slack バックエンドをリジリエントラッパーで包む（失敗時はローカルにフォールバック）
      return new ResilientNotificationBackend(slackBackend);
    }

    default:
      throw new Error(
        `Unknown NOTIFY_BACKEND: "${backend}". ` +
        `Supported values: "local" (macOS notification + terminal), "slack" (Slack bot). ` +
        `Set NOTIFY_BACKEND=local or NOTIFY_BACKEND=slack in your .env file.`,
      );
  }
}
