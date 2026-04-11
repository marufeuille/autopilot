import { createPipeline, step } from './runner';
import {
  handleStartApproval,
  handleSyncMain,
  handleImplementation,
  handlePRLifecycle,
  handleDocUpdate,
  handleDone,
} from './steps';
import { PipelineHooks, TaskContext } from './types';

const TASK_STEPS = [
  step<TaskContext>('start-approval', handleStartApproval),
  step<TaskContext>('sync-main', handleSyncMain),
  step<TaskContext>('implementation', handleImplementation),
  step<TaskContext>('pr-lifecycle', handlePRLifecycle),
  step<TaskContext>('doc-update', handleDocUpdate),
  step<TaskContext>('done', handleDone),
];

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
// パイプライン全体のリトライ上限: コスト保護および無限ループ防止のため明示的に設定
export const taskPipeline = createPipeline<TaskContext>(
  TASK_STEPS,
  { maxRetries: 10 },
);

/**
 * フック付きタスク実行パイプラインを生成するファクトリ。
 * OTel 等の計装フックを注入する場合に使用する。
 * hooks が undefined の場合は通常の taskPipeline と同等。
 */
export function createTaskPipeline(hooks?: PipelineHooks) {
  return createPipeline<TaskContext>(
    TASK_STEPS,
    { maxRetries: 10, hooks },
  );
}
