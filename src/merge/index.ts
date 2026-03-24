/**
 * マージモジュール
 *
 * PRステータス取得・マージポーリングを提供する。
 */

export {
  MergeError,
  type MergeErrorCode,
  type PullRequestStatus,
  type StatusCheck,
  type MergePollingOptions,
  type MergePollingResult,
} from './types';

export {
  type MergeServiceDeps,
  fetchPullRequestStatus,
} from './merge-service';

export { runMergePollingLoop } from './polling';
