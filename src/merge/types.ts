/**
 * マージサービスの型定義
 *
 * マージ実行の結果やエラーを構造化して表現する。
 */

/**
 * マージエラーの種別
 */
export type MergeErrorCode =
  | 'ci_not_passed'          // CI未完了・未通過
  | 'insufficient_approvals' // 承認数不足
  | 'permission_denied'      // 権限不足
  | 'merge_conflict'         // マージコンフリクト
  | 'branch_protected'       // ブランチ保護ルール違反
  | 'pr_not_open'            // PRがオープン状態でない
  | 'unknown';               // その他のエラー

/**
 * 構造化されたマージエラー
 */
export class MergeError extends Error {
  readonly code: MergeErrorCode;
  readonly statusCode: number;
  readonly reason: string;

  constructor(code: MergeErrorCode, reason: string, statusCode: number, cause?: Error) {
    super(reason);
    this.name = 'MergeError';
    this.code = code;
    this.statusCode = statusCode;
    this.reason = reason;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * マージ前のバリデーション結果
 */
export interface MergeValidationResult {
  /** マージ可能かどうか */
  mergeable: boolean;
  /** マージ不可の場合の理由一覧 */
  errors: MergeValidationError[];
}

/**
 * バリデーションエラー個別項目
 */
export interface MergeValidationError {
  code: MergeErrorCode;
  message: string;
}

/**
 * PRのステータス情報（gh pr view で取得）
 */
export interface PullRequestStatus {
  /** PRの状態 (OPEN, CLOSED, MERGED) */
  state: string;
  /** マージ可能かどうか (MERGEABLE, CONFLICTING, UNKNOWN) */
  mergeable: string;
  /** レビュー承認の状態 */
  reviewDecision: string;
  /** CIステータスチェックの結論 */
  statusCheckRollup: StatusCheck[];
}

/**
 * CIステータスチェック
 */
export interface StatusCheck {
  name: string;
  status: string;
  conclusion: string;
}

/**
 * マージ実行結果
 */
export interface MergeResult {
  /** マージ成功かどうか */
  success: boolean;
  /** マージされたPR URL */
  prUrl: string;
  /** マージ出力メッセージ */
  output?: string;
}
