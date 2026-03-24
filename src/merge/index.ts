/**
 * マージモジュール
 *
 * PRマージの事前検証・実行・エラーハンドリングを提供する。
 */

export {
  MergeError,
  type MergeErrorCode,
  type MergeResult,
  type MergeValidationResult,
  type MergeValidationError,
  type PullRequestStatus,
  type StatusCheck,
  type MergePollingOptions,
  type MergePollingResult,
} from './types';

export {
  type MergeServiceDeps,
  fetchPullRequestStatus,
  validateMergeConditions,
  classifyMergeError,
  executeMerge,
  formatMergeErrorMessage,
} from './merge-service';

export { runMergePollingLoop } from './polling';
