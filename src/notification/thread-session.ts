/**
 * スレッドセッション管理モジュール
 *
 * storySlug → thread_ts のマッピングを管理し、
 * 1つの story の承認フローを1つの Slack スレッドにまとめる基盤を提供する。
 */

/**
 * スレッドセッションマネージャー
 *
 * story 実行中のすべての通知・承認依頼を1つの Slack スレッドに集約するため、
 * storySlug をキーにスレッドの起点メッセージの timestamp (thread_ts) を保持する。
 */
export class ThreadSessionManager {
  private readonly sessions = new Map<string, string>();

  /**
   * セッションを開始（storySlug → thread_ts を登録）
   *
   * @param storySlug ストーリーの識別子
   * @param threadTs Slack スレッドの起点メッセージの timestamp
   */
  startSession(storySlug: string, threadTs: string): void {
    this.sessions.set(storySlug, threadTs);
  }

  /**
   * storySlug に対応する thread_ts を取得する
   *
   * @param storySlug ストーリーの識別子
   * @returns thread_ts（セッション未開始の場合は undefined）
   */
  getThreadTs(storySlug: string): string | undefined {
    return this.sessions.get(storySlug);
  }

  /**
   * セッションを終了（storySlug のマッピングを削除）
   *
   * @param storySlug ストーリーの識別子
   */
  endSession(storySlug: string): void {
    this.sessions.delete(storySlug);
  }
}
