/**
 * 通知バックエンドのファクトリ
 *
 * 環境変数 NOTIFY_BACKEND で切り替える。
 * - "local": macOS 通知 + ターミナル入力
 * - "slack": Slack バックエンド（既存）
 * - 未設定: デフォルトは "slack"（後方互換）
 */
export { NotificationBackend, ApprovalResult, LocalBackendOptions } from './types';
export { LocalNotificationBackend } from './local';

import { NotificationBackend, LocalBackendOptions } from './types';
import { LocalNotificationBackend } from './local';

export function createNotificationBackend(
  options?: { localOptions?: LocalBackendOptions },
): NotificationBackend {
  const backend = process.env.NOTIFY_BACKEND ?? 'slack';

  switch (backend) {
    case 'local':
      return new LocalNotificationBackend(options?.localOptions);
    case 'slack':
      // Slack バックエンドは別途実装予定。ここでは local にフォールバック。
      throw new Error(
        'Slack backend is not yet migrated to NotificationBackend interface. ' +
        'Use NOTIFY_BACKEND=local or migrate the Slack backend first.',
      );
    default:
      throw new Error(`Unknown NOTIFY_BACKEND: ${backend}`);
  }
}
