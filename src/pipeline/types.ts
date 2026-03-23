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
 * Pipeline の各 step をまたいで状態を受け渡すコンテキスト。
 * get/set は Map ベースの汎用ストア。型安全性は後続 PR で改善する。
 */
export interface TaskContext {
  readonly task: TaskFile;
  readonly story: StoryFile;
  readonly repoPath: string;
  readonly notifier: NotificationBackend;
  readonly deps: RunnerDeps;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  getRetryReason(): string | undefined;
  setRetryReason(reason: string): void;
}
