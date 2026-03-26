import type { StoryFile, StoryStatus } from '../vault/reader';

/**
 * QueueManager の外部依存。テスト時に差し替え可能。
 */
export interface QueueManagerDeps {
  /** storySlug からストーリーファイルを読み込む */
  readStoryBySlug: (storySlug: string) => StoryFile;
  /** ファイルのステータスを更新する */
  updateFileStatus: (filePath: string, status: StoryStatus) => void;
}

/**
 * ストーリーキューの管理
 *
 * Queued ストーリーを FIFO で保持し、順次実行する。
 * isQueuePaused フラグが true のとき、次のストーリーの起動をスキップする。
 */
export class StoryQueueManager {
  private queue: StoryFile[] = [];
  private paused = false;
  private deps: QueueManagerDeps | undefined;

  constructor(deps?: QueueManagerDeps) {
    this.deps = deps;
  }

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

  // ──────────────────────────────────
  // 高レベル API（slug ベース）
  // ──────────────────────────────────

  /**
   * Story をキュー末尾に追加し、ステータスを Queued に変更する。
   *
   * - Story の現在のステータスが Todo でない場合はエラー
   * - 同一 Story が既にキューに存在する場合はエラー（重複防止）
   * - deps が未設定の場合はエラー
   */
  add(storySlug: string): StoryFile {
    const deps = this.requireDeps();

    // Story を読み込む（存在しない場合は readStoryBySlug がエラーを throw する）
    const story = deps.readStoryBySlug(storySlug);

    // Draft → Queued への直接遷移を禁止（Todo のみ Queued にできる）
    if (story.status !== 'Todo') {
      throw new Error(
        `Story "${storySlug}" のステータスが "${story.status}" です。Queued に変更できるのは Todo のみです`,
      );
    }

    // 重複防止
    if (this.queue.some((s: StoryFile) => s.slug === storySlug)) {
      throw new Error(`Story "${storySlug}" は既にキューに存在します`);
    }

    // ステータスを Queued に変更
    deps.updateFileStatus(story.filePath, 'Queued');
    const queuedStory: StoryFile = { ...story, status: 'Queued' };

    this.queue.push(queuedStory);
    return queuedStory;
  }

  /**
   * Story をキューから削除し、ステータスを Todo に戻す。
   *
   * - キュー内に該当 Story が存在しない場合はエラー
   * - deps が未設定の場合はエラー
   */
  cancel(storySlug: string): StoryFile {
    const deps = this.requireDeps();

    const index = this.queue.findIndex((s: StoryFile) => s.slug === storySlug);
    if (index === -1) {
      throw new Error(`Story "${storySlug}" はキューに存在しません`);
    }

    const [removed] = this.queue.splice(index, 1);

    // ステータスを Todo に戻す
    deps.updateFileStatus(removed.filePath, 'Todo');
    return { ...removed, status: 'Todo' };
  }

  /**
   * キュー内のストーリー一覧を返す（コピー）。
   */
  list(): StoryFile[] {
    return [...this.queue];
  }

  /**
   * キュー先頭のストーリーを取り出して返す。
   * dequeue と同じだが、名前を揃えるためのエイリアス。
   *
   * - キューが空の場合は undefined
   * - isQueuePaused が true の場合は undefined
   */
  shift(): StoryFile | undefined {
    if (this.paused) return undefined;
    return this.queue.shift();
  }

  // ──────────────────────────────────
  // 低レベル API（StoryFile ベース）
  // ──────────────────────────────────

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

  // ──────────────────────────────────
  // プライベート
  // ──────────────────────────────────

  private requireDeps(): QueueManagerDeps {
    if (!this.deps) {
      throw new Error('QueueManagerDeps が設定されていません。コンストラクタで deps を渡してください');
    }
    return this.deps;
  }
}
