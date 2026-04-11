import type { RetryContext } from '../pipeline/types';
import type { ReviewLoopResult } from './loop';

/**
 * ReviewLoopResult から retry 用の構造化文脈を組み立てる。
 *
 * - errorFindings: severity === 'error' の指摘のみ抽出（WARNING は含めない）
 * - reviewSummary: 最終レビューの summary
 * - reason: 固定文言 "セルフレビュー未通過"
 */
export function buildRetryContext(reviewLoopResult: ReviewLoopResult): RetryContext {
  const errorFindings = reviewLoopResult.lastReviewResult.findings
    .filter((f) => f.severity === 'error');

  return {
    reason: 'セルフレビュー未通過',
    reviewSummary: reviewLoopResult.lastReviewResult.summary,
    errorFindings: errorFindings.length > 0 ? errorFindings : undefined,
  };
}
