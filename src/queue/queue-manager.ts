import type { StoryFile } from '../vault/reader';

/**
 * ストーリーキューの管理
 *
 * Queued ストーリーを FIFO で保持し、順次実行する。
 * isQueuePaused フラグが true のとき、次のストーリーの起動をスキップする。
 */
export class StoryQueueManager {
  private queue: StoryFile[] = [];
  private paused = false;

  /** キューが停止中かどうか */
  get isQueuePaused(): boolean {
    return this.paused;
  }

  /** キューを停止する */
  pauseQueue(): void {
    this.paused = true;
  }

  /** キューを再開する */
  resumeQueue(): void {
    this.paused = false;
  }

  /** ストーリーをキュー末尾に追加する */
  enqueue(story: StoryFile): void {
    this.queue.push(story);
  }

  /** ストーリーをキュー先頭に挿入する */
  prepend(story: StoryFile): void {
    this.queue.unshift(story);
  }

  /**
   * 次に実行すべきストーリーを取り出す。
   *
   * - キューが空の場合は undefined を返す
   * - isQueuePaused が true の場合は undefined を返す（ガード条件）
   */
  dequeue(): StoryFile | undefined {
    if (this.paused) return undefined;
    return this.queue.shift();
  }

  /** キュー先頭のストーリーを取り出さずに参照する */
  peek(): StoryFile | undefined {
    return this.queue[0];
  }

  /** キュー内のストーリー数 */
  get size(): number {
    return this.queue.length;
  }

  /** キューが空かどうか */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * キュー内の全ストーリーを取り出して返し、キューを空にする。
   * paused フラグはリセットしない。
   */
  drain(): StoryFile[] {
    const stories = [...this.queue];
    this.queue = [];
    return stories;
  }
}
