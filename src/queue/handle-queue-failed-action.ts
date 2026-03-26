import type { StoryFile } from '../vault/reader';
import type { NotificationBackend } from '../notification/types';
import type { QueueFailedAction } from '../notification/types';
import type { StoryQueueManager } from './queue-manager';

/**
 * キュー停止時の3択アクションハンドラ
 *
 * Story が Failed でキューが停止した後、ユーザーが選択したアクションに基づいて
 * キューの状態遷移を実行する。
 *
 * - resume（スキップして次へ）: キューを再開し次の Story を返す。空なら通知のみ。
 * - retry（このStoryをリトライ）: Failed Story を Todo に戻しキュー先頭に再追加して返す。
 * - clear（キューをすべてクリア）: 残りの Queued Stories を Todo に戻しキューを空にする。
 */

export interface HandleQueueFailedActionDeps {
  updateFileStatus: (filePath: string, status: string) => void;
}

export type QueueActionResult =
  | { outcome: 'next'; story: StoryFile }   // 次に実行すべき Story がある
  | { outcome: 'empty' }                    // キューが空（resume 時）
  | { outcome: 'cleared' };                 // キューをクリアした

/**
 * ユーザーが選択したキュー停止アクションを実行する。
 *
 * @param action ユーザーが選択したアクション
 * @param failedStory Failed になったストーリー
 * @param queueManager キューマネージャー
 * @param notifier 通知バックエンド
 * @param deps 外部依存（テスト時に差し替え可能）
 * @returns アクション実行結果
 */
export async function handleQueueFailedAction(
  action: QueueFailedAction,
  failedStory: StoryFile,
  queueManager: StoryQueueManager,
  notifier: NotificationBackend,
  deps: HandleQueueFailedActionDeps,
): Promise<QueueActionResult> {
  switch (action) {
    case 'resume':
      return handleResume(queueManager, notifier, failedStory);

    case 'retry':
      return handleRetry(failedStory, queueManager, notifier, deps);

    case 'clear':
      return handleClear(queueManager, notifier, failedStory, deps);

    default: {
      const _exhaustive: never = action;
      throw new Error(`Unexpected queue failed action: ${_exhaustive}`);
    }
  }
}

/**
 * スキップして次へ: キューを再開し、次の Queued Story を Doing に遷移する。
 * キューが空の場合は「キューが空になりました」と通知のみ行う。
 */
async function handleResume(
  queueManager: StoryQueueManager,
  notifier: NotificationBackend,
  failedStory: StoryFile,
): Promise<QueueActionResult> {
  queueManager.resumeQueue();

  const next = queueManager.dequeue();
  if (!next) {
    await notifier.notify('📭 キューが空になりました', failedStory.slug);
    console.log('[queue] resume: queue is empty');
    return { outcome: 'empty' };
  }

  await notifier.notify(
    `⏭ スキップしました。次のStoryを開始します: \`${next.slug}\``,
    failedStory.slug,
  );
  console.log(`[queue] resume: starting next story: ${next.slug}`);
  return { outcome: 'next', story: next };
}

/**
 * このStoryをリトライ: Failed Story を Todo に戻し、キュー先頭に再挿入して実行する。
 */
async function handleRetry(
  failedStory: StoryFile,
  queueManager: StoryQueueManager,
  notifier: NotificationBackend,
  deps: HandleQueueFailedActionDeps,
): Promise<QueueActionResult> {
  deps.updateFileStatus(failedStory.filePath, 'Todo');
  const retryStory: StoryFile = { ...failedStory, status: 'Todo' };
  queueManager.prepend(retryStory);
  queueManager.resumeQueue();

  const next = queueManager.dequeue();
  // prepend 直後なので必ず取り出せるはずだが念のため
  if (!next) {
    throw new Error('[queue] retry: unexpected empty queue after prepend');
  }

  await notifier.notify(
    `🔄 リトライします: \`${failedStory.slug}\``,
    failedStory.slug,
  );
  console.log(`[queue] retry: retrying story: ${failedStory.slug}`);
  return { outcome: 'next', story: next };
}

/**
 * キューをすべてクリア: 残りの Queued Stories を Todo に戻し、キューを空にする。
 */
async function handleClear(
  queueManager: StoryQueueManager,
  notifier: NotificationBackend,
  failedStory: StoryFile,
  deps: HandleQueueFailedActionDeps,
): Promise<QueueActionResult> {
  const drained = queueManager.drain();

  for (const story of drained) {
    deps.updateFileStatus(story.filePath, 'Todo');
  }

  await notifier.notify(
    `🗑 キューをクリアしました（${drained.length}件のStoryをTodoに戻しました）`,
    failedStory.slug,
  );
  console.log(`[queue] clear: ${drained.length} stories returned to Todo`);
  return { outcome: 'cleared' };
}
