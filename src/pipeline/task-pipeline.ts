import { createPipeline, step } from './runner';
import {
  handleStartApproval,
  handleSyncMain,
  handleImplementation,
  handlePRLifecycle,
  handleDocUpdate,
  handleDone,
} from './steps';
import { TaskContext } from './types';

/**
 * タスク実行パイプライン定義
 *
 * 各 step の retry 先:
 * - Step 1 start-approval: skip (タスクをスキップ)
 * - Step 2 sync-main: abort (GitSyncError → 呼び出し側が Failed にセット)
 * - Step 3 implementation: retry from: 'implementation' (レビューNG)
 * - Step 4 pr-lifecycle: retry from: 'implementation' (CI失敗/PRクローズ/タイムアウト)
 * - Step 5 doc-update: (continue)
 * - Step 6 done: (常に continue)
 */
export const taskPipeline = createPipeline<TaskContext>([
  step('start-approval', handleStartApproval),
  step('sync-main', handleSyncMain),
  step('implementation', handleImplementation),
  step('pr-lifecycle', handlePRLifecycle),
  step('doc-update', handleDocUpdate),
  step('done', handleDone),
]);
