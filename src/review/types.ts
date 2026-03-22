/**
 * レビュー指摘事項
 */
export interface ReviewFinding {
  /** ファイルパス（該当する場合） */
  file?: string;
  /** 行番号（該当する場合） */
  line?: number;
  /** 重要度: error=必ず修正, warning=修正推奨, info=参考情報 */
  severity: 'error' | 'warning' | 'info';
  /** 指摘内容 */
  message: string;
}

/**
 * レビュー結果
 */
export interface ReviewResult {
  /** OK=問題なし, NG=修正が必要 */
  verdict: 'OK' | 'NG';
  /** レビューの要約コメント */
  summary: string;
  /** 指摘事項リスト */
  findings: ReviewFinding[];
}

/**
 * レビューエージェントのエラー
 */
export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

/**
 * レビューエージェントのタイムアウトエラー
 */
export class ReviewTimeoutError extends ReviewError {
  constructor(public readonly timeoutMs: number) {
    super(`Review agent timed out after ${timeoutMs}ms`);
    this.name = 'ReviewTimeoutError';
  }
}
