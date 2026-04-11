/**
 * 通知バックエンドのファクトリ
 *
 * 環境変数 NOTIFY_BACKEND で切り替える。
 * - "local": macOS 通知 + ターミナル入力（デフォルト）
 * - "slack": Slack バックエンド
 * - 未設定: デフォルトは "local"
 */
export { NotificationBackend, ApprovalResult, NotificationEventType, NotificationContext, NotifyOptions, TaskFailureAction, QueueFailedAction, AcceptanceCheckResult, AcceptanceConditionResult, AcceptanceGateAction } from './types';
export { LocalNotificationBackend } from './local';
export { SlackNotificationBackend, registerPRRejectHandlers, registerReadmePRRejectHandler, registerTaskFailureHandlers, registerQueueFailedHandlers, registerAcceptanceGateHandlers } from './slack';
export { NtfyNotificationBackend } from './ntfy';
export { generateApprovalId } from './approval-id';
export { ThreadSessionManager } from './thread-session';
export { ResilientNotificationBackend, ResilientOptions } from './resilient';
export {
  buildNotificationMessage,
  buildMergeApprovalMessage,
  buildMergeCompletedMessage,
  buildMergeBlockedMessage,
  buildReviewEscalationMessage,
  buildCIEscalationMessage,
  buildThreadOriginMessage,
  buildReadmePRBlocks,
  buildMergeReadyBlocks,
  buildRejectModal,
  buildTaskFailureBlocks,
  buildQueueFailedBlocks,
  buildAcceptanceGateBlocks,
  buildAcceptanceCommentModal,
} from './message-builder';
export type { MergeConditionItem } from './types';

import { NotificationBackend } from './types';
import { LocalNotificationBackend } from './local';
import { ResilientNotificationBackend } from './resilient';
import type { StoryQueueManager } from '../queue/queue-manager';

/**
 * createNotificationBackend のオプション
 */
export interface CreateNotificationBackendOptions {
  /**
   * 外部から渡すキューマネージャー（単一）。
   * 後方互換のために維持。queueManagers が指定された場合はそちらが優先される。
   */
  queueManager?: StoryQueueManager;

  /**
   * 外部から渡すプロジェクト別キューマネージャー Map。
   * Slack バックエンドで queue サブコマンドに使用する。
   * 未指定の場合は queueManager から単一プロジェクト用の Map を生成する。
   */
  queueManagers?: Map<string, StoryQueueManager>;
}

/**
 * 環境変数 NOTIFY_BACKEND に基づいて適切な通知バックエンドを生成する。
 *
 * - "local"（デフォルト）: macOS システム通知 + ターミナル入力
 * - "slack": Slack ボット経由の通知・承認フロー（動的インポート）
 * - "ntfy": ntfy.sh 経由のプッシュ通知
 *
 * @throws 未知のバックエンド指定時にエラー
 */
export async function createNotificationBackend(
  options?: CreateNotificationBackendOptions,
): Promise<NotificationBackend> {
  const backend = process.env.NOTIFY_BACKEND ?? 'local';

  switch (backend) {
    case 'local':
      return new LocalNotificationBackend();

    case 'slack': {
      // Slack 依存を動的インポート（local 使用時は不要な依存を読み込まない）
      const { createSlackApp } = await import('../slack/bot');
      const { registerApprovalHandlers, registerPRRejectHandlers, registerReadmePRRejectHandler, registerTaskFailureHandlers, registerQueueFailedHandlers, registerAcceptanceGateHandlers, SlackNotificationBackend } = await import('./slack');

      const { registerSlashCommands, registerSubcommand } = await import('../slack/slash-commands');
      const { handleStatus } = await import('../slack/commands/status');
      const { handleRetry } = await import('../slack/commands/retry');
      const { handleHelp } = await import('../slack/commands/help');
      const { createStoryHandler } = await import('../slack/commands/story');
      const { createFixHandler } = await import('../slack/commands/fix');
      const { registerThreadHandler } = await import('../slack/thread-handler');
      const { registerStoryApprovalHandlers } = await import('../slack/actions/story-approval');
      const { registerFixApprovalHandlers } = await import('../slack/actions/fix-approval');
      const { createQueueHandler } = await import('../slack/commands/queue');

      registerSubcommand('status', handleStatus);
      registerSubcommand('retry', handleRetry);
      registerSubcommand('help', handleHelp);

      // 外部から渡されたキューマネージャー Map を使うか、内部で新規生成する
      let queueManagers: Map<string, StoryQueueManager>;
      if (options?.queueManagers) {
        queueManagers = options.queueManagers;
      } else if (options?.queueManager) {
        // 後方互換: 単一 QueueManager を Map に変換
        const { config } = await import('../config');
        queueManagers = new Map([[config.watchProject, options.queueManager]]);
      } else {
        const { StoryQueueManager: QM } = await import('../queue/queue-manager');
        const { readStoryBySlug } = await import('../vault/reader');
        const { updateFileStatus } = await import('../vault/writer');
        const { config } = await import('../config');
        queueManagers = new Map<string, StoryQueueManager>();
        for (const project of config.watchProjects) {
          queueManagers.set(
            project,
            new QM({
              readStoryBySlug: (slug: string) => readStoryBySlug(slug, project),
              updateFileStatus,
            }),
          );
        }
      }
      registerSubcommand('queue', createQueueHandler(queueManagers));

      const slackApp = createSlackApp();
      registerSubcommand('story', createStoryHandler(slackApp));
      registerSubcommand('fix', createFixHandler(slackApp));
      registerApprovalHandlers(slackApp);
      registerPRRejectHandlers(slackApp);
      registerReadmePRRejectHandler(slackApp);
      registerTaskFailureHandlers(slackApp);
      registerQueueFailedHandlers(slackApp);
      registerAcceptanceGateHandlers(slackApp);
      registerStoryApprovalHandlers(slackApp);
      registerFixApprovalHandlers(slackApp);
      registerSlashCommands(slackApp);
      registerThreadHandler(slackApp);
      await slackApp.start();
      console.log('[slack] bot started (Socket Mode) — slash commands, thread handler, approval handlers registered');

      const slackBackend = new SlackNotificationBackend(slackApp);
      // Slack バックエンドをリジリエントラッパーで包む（失敗時はローカルにフォールバック）
      return new ResilientNotificationBackend(slackBackend);
    }

    case 'ntfy': {
      const { config } = await import('../config');
      const { NtfyNotificationBackend } = await import('./ntfy');

      const ntfyBackend = new NtfyNotificationBackend(
        config.ntfy.serverUrl,
        config.ntfy.topic,
      );
      // ntfy バックエンドをリジリエントラッパーで包む（失敗時はローカルにフォールバック）
      return new ResilientNotificationBackend(ntfyBackend);
    }

    default:
      throw new Error(
        `Unknown NOTIFY_BACKEND: "${backend}". ` +
        `Supported values: "local" (macOS notification + terminal), "slack" (Slack bot), "ntfy" (ntfy.sh push). ` +
        `Set NOTIFY_BACKEND=local or NOTIFY_BACKEND=slack or NOTIFY_BACKEND=ntfy in your .env file.`,
      );
  }
}
