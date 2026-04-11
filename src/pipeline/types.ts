import { StoryFile, StoryStatus, TaskFile } from '../vault/reader';
import { NotificationBackend } from '../notification/types';
import { RunnerDeps } from '../runner-deps';

export type StepName = string;

export type FlowSignal =
  | { kind: 'continue' }
  | { kind: 'retry'; from: StepName; reason: string }
  | { kind: 'skip' }
  | { kind: 'abort'; error: Error };

export type PipelineResult = 'done' | 'skipped' | 'aborted';

/**
 * ステップ完了時にフックへ渡される情報。
 */
export interface StepEndInfo {
  /** ステップ名 */
  name: StepName;
  /** ステップが返した FlowSignal の kind */
  signal: FlowSignal['kind'];
}

/**
 * Pipeline のライフサイクルフック。
 * 計装（OTel 等）をビジネスロジックに依存させずに差し込むためのインターフェース。
 * すべて optional — 未登録時は no-op。
 */
export interface PipelineHooks {
  /** Pipeline 実行開始時に呼ばれる */
  onPipelineStart?: (ctx: TaskContext) => void | Promise<void>;
  /** Pipeline 実行終了時に呼ばれる（result: done / skipped、または abort 時は undefined） */
  onPipelineEnd?: (ctx: TaskContext, result: PipelineResult | undefined) => void | Promise<void>;
  /** 各ステップの実行前に呼ばれる */
  onStepStart?: (ctx: TaskContext, stepName: StepName) => void | Promise<void>;
  /** 各ステップの実行後に呼ばれる */
  onStepEnd?: (ctx: TaskContext, info: StepEndInfo) => void | Promise<void>;
}

export interface PipelineOptions {
  maxRetries?: number;
  hooks?: PipelineHooks;
}

/**
 * タスクの最終結果（Orchestrator レベル）。
 */
export type TaskResult = 'done' | 'failed' | 'skipped';

/**
 * Orchestrator（Story → Task 制御）のライフサイクルフック。
 * 計装（OTel 等）をビジネスロジックに依存させずに差し込むためのインターフェース。
 * すべて optional — 未登録時は no-op。
 */
export interface OrchestratorHooks {
  /** Story 実行開始時に呼ばれる */
  onStoryStart?: (story: StoryFile, info: { taskCount: number }) => void | Promise<void>;
  /** Story 実行終了時に呼ばれる */
  onStoryEnd?: (story: StoryFile, result: StoryStatus) => void | Promise<void>;
  /** Task 実行開始時に呼ばれる */
  onTaskStart?: (task: TaskFile, story: StoryFile) => void | Promise<void>;
  /** Task 実行終了時に呼ばれる */
  onTaskEnd?: (task: TaskFile, story: StoryFile, result: TaskResult, info: { retryCount: number }) => void | Promise<void>;
  /**
   * Pipeline 実行時に使用するフックを返す。
   * OTel の場合、Task スパンを親として Step スパンを生成するために使用する。
   */
  getPipelineHooks?: () => PipelineHooks | undefined;
}

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
  /** PR却下理由（rejected 時に implementation step へ引き継ぐ） */
  rejectionReason?: string;
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
