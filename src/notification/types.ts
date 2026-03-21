/**
 * 通知バックエンドのインターフェース定義
 *
 * すべての通知バックエンド（local, slack など）はこのインターフェースを実装する。
 */

/** 承認リクエストの結果 */
export type ApprovalResult =
  | { action: 'approve' }
  | { action: 'reject'; reason: string };

/** 通知バックエンドが実装すべきインターフェース */
export interface NotificationBackend {
  /**
   * 通知を送信する（情報通知、完了通知など）
   * @param message 通知メッセージ
   */
  notify(message: string): Promise<void>;

  /**
   * 承認リクエストを送信し、結果を待つ
   * @param id 承認リクエストの一意識別子
   * @param message 承認プロンプトに表示するメッセージ
   * @param buttons ボタンラベル（approve / reject）
   * @returns 承認結果
   */
  requestApproval(
    id: string,
    message: string,
    buttons: { approve: string; reject: string },
  ): Promise<ApprovalResult>;
}
