/**
 * CI ポーリングの設定オプション
 */
export interface CIPollingOptions {
  /** ポーリング間隔（ミリ秒、デフォルト: 30000 = 30秒） */
  pollingIntervalMs?: number;
  /** 最大待機時間（ミリ秒、デフォルト: 900000 = 15分） */
  maxWaitMs?: number;
  /** CI失敗時の最大リトライ回数（デフォルト: 3） */
  maxRetries?: number;
  /** runs 空時の最大リトライ回数（デフォルト: 10、環境変数 CI_EMPTY_RUNS_MAX_RETRIES で上書き可能） */
  emptyRunsMaxRetries?: number;
}

/**
 * CI ステータスの種別
 */
export type CIStatus = 'pending' | 'success' | 'failure';

/**
 * CI 実行結果
 */
export interface CIRunResult {
  /** CI ステータス */
  status: CIStatus;
  /** 実行結果の要約 */
  summary: string;
  /** 失敗ログ（失敗時のみ） */
  failureLogs?: string;
  /** GitHub Actions の Run URL */
  runUrl?: string;
  /** pending の理由（'no_runs_yet': CI実行がまだ存在しない） */
  reason?: 'no_runs_yet';
}

/**
 * CI ポーリングの最終結果
 */
export interface CIPollingResult {
  /** 最終ステータス */
  finalStatus: 'success' | 'failure' | 'timeout' | 'max_retries_exceeded' | 'no_ci';
  /** CI の実行回数（初回含む） */
  attempts: number;
  /** 各試行の結果ログ */
  attemptResults: CIAttemptResult[];
  /** 最後の CI 実行結果 */
  lastCIResult?: CIRunResult;
}

/**
 * 各試行の記録
 */
export interface CIAttemptResult {
  /** 試行番号（1始まり） */
  attempt: number;
  /** CI 実行結果 */
  ciResult: CIRunResult;
  /** 修正内容（修正が行われた場合） */
  fixDescription?: string;
  /** タイムスタンプ */
  timestamp: Date;
}

/**
 * CI ポーリングエラー
 */
export class CIPollingError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'CIPollingError';
  }
}

/**
 * CI ポーリングタイムアウトエラー
 */
export class CIPollingTimeoutError extends CIPollingError {
  constructor(public readonly maxWaitMs: number) {
    super(`CI polling timed out after ${maxWaitMs}ms`);
    this.name = 'CIPollingTimeoutError';
  }
}
