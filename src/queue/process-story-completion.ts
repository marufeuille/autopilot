import type { StoryStatus } from '../vault/reader';
import type { StoryQueueManager } from './queue-manager';

/**
 * ストーリー完了時のキュー制御結果
 */
export type StoryCompletionResult =
  | { action: 'continue' }    // 次の Queued Story を実行する
  | { action: 'paused' }      // キューを停止した（Failed）
  | { action: 'noop' };       // キューが空なので何もしない

/**
 * ストーリー完了時のステータスに応じてキューの停止/継続を制御する。
 *
 * - Failed: キューを停止する（isQueuePaused = true）
 * - Done / Cancelled: キューを継続する（次の Queued Story を実行可能にする）
 *
 * @param status 完了したストーリーの最終ステータス
 * @param queueManager キューマネージャー
 * @returns キュー制御結果
 */
export function processStoryCompletion(
  status: StoryStatus,
  queueManager: StoryQueueManager,
): StoryCompletionResult {
  if (status === 'Failed') {
    queueManager.pauseQueue();
    console.log('[queue] story failed — queue paused');
    return { action: 'paused' };
  }

  // Done / Cancelled はキューを継続
  if (queueManager.isEmpty) {
    return { action: 'noop' };
  }

  return { action: 'continue' };
}
