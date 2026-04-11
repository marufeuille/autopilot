import type { RetryContext } from '../pipeline/types';
import type { ReviewLoopResult } from './loop';

/**
 * buildRetryContext のオプション。
 * diffStat は外部から渡す（git コマンド実行は呼び出し側の責務）。
 */
export interface BuildRetryContextOptions {
  /** git diff --stat の出力（省略時は retryContext.diffStat が undefined になる） */
  diffStat?: string;
}

/**
 * ReviewLoopResult から retry 用の構造化文脈を組み立てる。
 *
 * - errorFindings: severity === 'error' の指摘のみ抽出（WARNING は含めない）
 * - reviewSummary: 最終レビューの summary
 * - diffStat: git diff --stat の出力（オプション）
 * - reason: 固定文言 "セルフレビュー未通過"
 */
export function buildRetryContext(
  reviewLoopResult: ReviewLoopResult,
  options: BuildRetryContextOptions = {},
): RetryContext {
  const errorFindings = reviewLoopResult.lastReviewResult.findings
    .filter((f) => f.severity === 'error');

  return {
    reason: 'セルフレビュー未通過',
    diffStat: options.diffStat,
    reviewSummary: reviewLoopResult.lastReviewResult.summary,
    errorFindings: errorFindings.length > 0 ? errorFindings : undefined,
  };
}
