import { FlowSignal, PipelineOptions, PipelineResult, Step, StepName, TaskContext } from './types';

export const DEFAULT_MAX_RETRIES = 10;

/**
 * Pipeline ランナーを生成する。
 *
 * steps 配列を受け取り、コンテキストを引数に取る非同期 run 関数を返す。
 * 各 step が返す FlowSignal によって次の遷移先を決定する。
 *
 * - continue: 次の step へ進む
 * - skip: pipeline を即座に終了し 'skipped' を返す
 * - abort: signal.error を throw する
 * - retry: signal.from で指定した step 名まで巻き戻す
 */
export function createPipeline<TCtx extends TaskContext>(steps: Step<TCtx>[], options?: PipelineOptions) {
  const _maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

  return async function run(ctx: TCtx): Promise<PipelineResult> {
    let stepIndex = 0;

    while (stepIndex < steps.length) {
      const current = steps[stepIndex];
      const signal: FlowSignal = await current.handler(ctx);

      switch (signal.kind) {
        case 'continue':
          stepIndex++;
          break;

        case 'skip':
          return 'skipped';

        case 'abort':
          throw signal.error;

        case 'retry': {
          const targetIndex = steps.findIndex((s) => s.name === signal.from);
          if (targetIndex === -1) {
            throw new Error(
              `[pipeline] Unknown step name in retry signal: "${signal.from}". ` +
              `Available steps: ${steps.map((s) => s.name).join(', ')}`,
            );
          }
          ctx.set('retryReason', signal.reason);
          stepIndex = targetIndex;
          break;
        }
      }
    }

    return 'done';
  };
}

/**
 * Step を生成するファクトリ。
 * createPipeline に渡す配列リテラルを読みやすくするためのヘルパー。
 */
export function step<TCtx extends TaskContext>(
  name: StepName,
  handler: (ctx: TCtx) => Promise<FlowSignal>,
): Step<TCtx> {
  return { name, handler };
}

/**
 * TaskContext の具体実装を生成するファクトリ。
 */
export function createTaskContext(
  args: Pick<TaskContext, 'task' | 'story' | 'repoPath' | 'notifier' | 'deps'>,
): TaskContext {
  const store = new Map<string, unknown>();
  return {
    ...args,
    get: <K extends import('./types').TaskContextKey>(key: K) => store.get(key) as import('./types').TaskContextStore[K],
    set: <K extends import('./types').TaskContextKey>(key: K, value: import('./types').TaskContextStore[K]) => { store.set(key, value); },
    getRetryReason: () => store.get('retryReason') as string | undefined,
    setRetryReason: (reason) => store.set('retryReason', reason),
  };
}
