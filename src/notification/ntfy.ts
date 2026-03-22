import { NotificationBackend, ApprovalResult } from './types';

/**
 * ntfy.sh 通知バックエンド
 *
 * - notify: ntfy.sh に POST でプッシュ通知を送信
 * - requestApproval: 未実装（今後 HTTP callback で実装予定）
 */
export class NtfyNotificationBackend implements NotificationBackend {
  private readonly serverUrl: string;
  private readonly topic: string;

  constructor(serverUrl: string, topic: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, ''); // trailing slash を除去
    this.topic = topic;
  }

  /**
   * ntfy.sh にプッシュ通知を送信する
   */
  async notify(message: string): Promise<void> {
    const url = `${this.serverUrl}/${this.topic}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Title': 'Autopilot',
      },
      body: message,
    });

    if (!response.ok) {
      throw new Error(
        `[ntfy] POST ${url} failed: ${response.status} ${response.statusText}`,
      );
    }

    console.log(`[ntfy] notification sent to ${this.topic}`);
  }

  /**
   * スレッドセッションを開始する（ntfy では no-op）
   */
  async startThread(_storySlug: string, _message: string): Promise<void> {
    // ntfy バックエンドではスレッドの概念がないため何もしない
  }

  /**
   * スレッドの thread_ts を取得する（ntfy では常に undefined）
   */
  getThreadTs(_storySlug: string): string | undefined {
    return undefined;
  }

  /**
   * 承認リクエスト（未実装）
   *
   * 今後の PR で ntfy.sh の HTTP callback を利用した承認フローを実装予定。
   */
  async requestApproval(
    _id: string,
    _message: string,
    _buttons: { approve: string; reject: string },
  ): Promise<ApprovalResult> {
    throw new Error(
      '[ntfy] requestApproval is not yet implemented. ' +
      'Will be available after HTTP callback endpoint is added.',
    );
  }
}
