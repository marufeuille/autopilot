import type { StoryFile, StoryStatus } from '../vault/reader';
import type { NotificationBackend } from '../notification/types';
import type { StoryQueueManager } from './queue-manager';
import { processStoryCompletion } from './process-story-completion';
import { handleQueueFailedAction } from './handle-queue-failed-action';
import type { HandleQueueFailedActionDeps } from './handle-queue-failed-action';

/**
 * auto-promote の外部依存。テスト時に差し替え可能。
 */
export interface AutoPromoteDeps extends HandleQueueFailedActionDeps {
  /** Story のパイプラインを起動する。完了後の StoryStatus を返す。 */
  runStory: (story: StoryFile, notifier: NotificationBackend) => Promise<StoryStatus>;
}

/**
 * Story 完了後にキュー先頭の Story を自動プロモートする。
 *
 * - Done / Cancelled: キュー先頭を Doing に遷移してパイプラインを起動
 * - Failed: キューを停止し Slack でユーザーの判断を仰ぐ（resume/retry/clear）
 * - キューが空: 何もしない
 *
 * 自動プロモート後は `runStory` を呼び出して既存のパイプラインに乗せる。
 * パイプライン完了後に再帰的にキュー先頭を自動プロモートし、
 * キューが空になるまで連鎖的に実行する。
 */
export async function promoteNextQueuedStory(
  completedStoryStatus: StoryStatus,
  completedStory: StoryFile,
  queueManager: StoryQueueManager,
  notifier: NotificationBackend,
  deps: AutoPromoteDeps,
): Promise<void> {
  const result = processStoryCompletion(completedStoryStatus, queueManager);

  switch (result.action) {
    case 'noop':
      console.log('[queue] no queued stories — nothing to promote');
      return;

    case 'continue': {
      const next = queueManager.shift();
      if (!next) {
        console.log('[queue] shift returned undefined — skipping promotion');
        return;
      }
      await startAndChain(next, queueManager, notifier, deps);
      return;
    }

    case 'paused': {
      await notifier.notify(
        `⏸ キューを停止しました。Story \`${completedStory.slug}\` が Failed です。`,
        completedStory.slug,
      );

      const action = await notifier.requestQueueFailedAction(
        completedStory.slug,
        `Story \`${completedStory.slug}\` が失敗しました。キューの操作を選択してください。`,
      );

      const actionResult = await handleQueueFailedAction(
        action,
        completedStory,
        queueManager,
        notifier,
        deps,
      );

      if (actionResult.outcome === 'next') {
        await startAndChain(actionResult.story, queueManager, notifier, deps);
      }
      return;
    }

    default: {
      const _exhaustive: never = result;
      throw new Error(`Unexpected StoryCompletionResult: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Story のステータスを Doing に変更し、パイプラインを起動する。
 * パイプライン完了後に再帰的にキュー先頭を自動プロモートする。
 */
async function startAndChain(
  story: StoryFile,
  queueManager: StoryQueueManager,
  notifier: NotificationBackend,
  deps: AutoPromoteDeps,
): Promise<void> {
  deps.updateFileStatus(story.filePath, 'Doing');
  const doingStory: StoryFile = { ...story, status: 'Doing' };

  await notifier.notify(
    `🚀 キューから自動起動: \`${story.slug}\``,
    story.slug,
  );
  console.log(`[queue] auto-promote: starting story: ${story.slug}`);

  let finalStatus: StoryStatus;
  try {
    finalStatus = await deps.runStory(doingStory, notifier);
  } catch (error) {
    console.error(`[queue] auto-promoted story failed with error: ${story.slug}`, error);
    finalStatus = 'Failed';
  }

  // パイプライン完了後、再帰的にキュー先頭を自動プロモート
  await promoteNextQueuedStory(finalStatus, doingStory, queueManager, notifier, deps);
}
