/**
 * マージサービスの型定義
 *
 * PRステータスの取得やマージポーリングに使用する型を定義する。
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
 * マージポーリングの設定オプション
 */
export interface MergePollingOptions {
  /** ポーリング間隔（ミリ秒、デフォルト: 30000 = 30秒） */
  pollingIntervalMs?: number;
  /** 最大待機時間（ミリ秒、デフォルト: 86400000 = 24時間） */
  maxWaitMs?: number;
  /** 連続エラーの上限回数（デフォルト: 10） */
  maxConsecutiveErrors?: number;
}

/**
 * マージポーリングの最終結果
 */
export interface MergePollingResult {
  /** 最終ステータス */
  finalStatus: 'merged' | 'closed' | 'timeout' | 'error';
  /** 経過時間（ミリ秒） */
  elapsedMs: number;
}
