import { StoryFile, TaskFile } from '../vault/reader';
import { NotificationBackend } from '../notification/types';
import { RunnerDeps } from '../runner-deps';

export type StepName = string;

export type FlowSignal =
  | { kind: 'continue' }
  | { kind: 'retry'; from: StepName; reason: string }
  | { kind: 'skip' }
  | { kind: 'abort'; error: Error };

export type PipelineResult = 'done' | 'skipped' | 'aborted';

export interface Step<TCtx> {
  name: StepName;
  handler: (ctx: TCtx) => Promise<FlowSignal>;
}

/**
 * Pipeline の各 step 間で受け渡される型付きフィールド。
 */
export interface TaskContextStore {
  /** PR の URL（リモートありの場合） */
  prUrl?: string;
  /** ローカルオンリーモードかどうか（no-remote 時） */
  localOnly?: boolean;
  /** ローカルコミットの SHA（no-remote 時） */
  commitSha?: string;
  /** セルフレビュー結果 */
  reviewResult?: import('../review').ReviewLoopResult;
  /** リトライ理由（pipeline 内部で使用） */
  retryReason?: string;
  /** git worktree の作業ディレクトリパス */
  worktreePath?: string;
}

/** TaskContextStore のキー型 */
export type TaskContextKey = keyof TaskContextStore;

/**
 * Pipeline の各 step をまたいで状態を受け渡すコンテキスト。
 * get/set は型安全なアクセスを提供する。
 */
export interface TaskContext {
  readonly task: TaskFile;
  readonly story: StoryFile;
  readonly repoPath: string;
  readonly notifier: NotificationBackend;
  readonly deps: RunnerDeps;
  get<K extends TaskContextKey>(key: K): TaskContextStore[K];
  set<K extends TaskContextKey>(key: K, value: TaskContextStore[K]): void;
  getRetryReason(): string | undefined;
  setRetryReason(reason: string): void;
}
