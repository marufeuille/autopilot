import { createPipeline, step } from './runner';
import {
  handleStartApproval,
  handleSyncMain,
  handleImplementation,
  handlePRLifecycle,
  handleDone,
} from './steps';
import { TaskContext } from './types';

/**
 * タスク実行パイプライン定義
 *
 * 各 step の retry 先:
 * - start-approval: skip (タスクをスキップ)
 * - sync-main: abort (GitSyncError → 呼び出し側が Failed にセット)
 * - implementation: retry from: 'implementation' (レビューNG)
 * - pr-lifecycle: retry from: 'implementation' (CI失敗/マージ承認拒否), retry from: 'pr-lifecycle' (マージ失敗)
 * - done: (常に continue)
 */
export const taskPipeline = createPipeline<TaskContext>([
  step('start-approval', handleStartApproval),
  step('sync-main', handleSyncMain),
  step('implementation', handleImplementation),
  step('pr-lifecycle', handlePRLifecycle),
  step('done', handleDone),
]);
