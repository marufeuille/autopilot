import { FlowSignal, PipelineHooks, PipelineOptions, PipelineResult, Step, StepName, TaskContext } from './types';

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
 *
 * options.hooks を渡すと、ステップ実行前後および Pipeline 開始・終了時に
 * コールバックが呼ばれる。フック未登録時は no-op。
 */
export function createPipeline<TCtx extends TaskContext>(steps: Step<TCtx>[], options?: PipelineOptions) {
  const _maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const hooks: PipelineHooks = options?.hooks ?? {};

  return async function run(ctx: TCtx): Promise<PipelineResult> {
    let stepIndex = 0;
    let retryCount = 0;
    let result: PipelineResult | undefined;

    await hooks.onPipelineStart?.(ctx);

    let pipelineEndCalled = false;

    try {
      while (stepIndex < steps.length) {
        const current = steps[stepIndex];

        await hooks.onStepStart?.(ctx, current.name);
        const signal: FlowSignal = await current.handler(ctx);
        await hooks.onStepEnd?.(ctx, { name: current.name, signal: signal.kind });

        switch (signal.kind) {
          case 'continue':
            stepIndex++;
            break;

          case 'skip':
            result = 'skipped';
            pipelineEndCalled = true;
            await hooks.onPipelineEnd?.(ctx, result);
            return result;

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

            retryCount++;
            if (retryCount > _maxRetries) {
              throw new Error(
                `Pipeline retry limit exceeded (${retryCount - 1}/${_maxRetries}): ` +
                `last retry requested by step "${current.name}", reason: "${signal.reason}"`,
              );
            }

            ctx.set('retryReason', signal.reason);
            // retryContext が未設定の場合は reason のみで初期化
            // （レビュー起因の retry では step 側で詳細な retryContext を事前にセットする）
            if (!ctx.get('retryContext')) {
              ctx.set('retryContext', { reason: signal.reason });
            }
            stepIndex = targetIndex;
            break;
          }
        }
      }

      result = 'done';
      pipelineEndCalled = true;
      await hooks.onPipelineEnd?.(ctx, result);
      return result;
    } catch (error) {
      if (!pipelineEndCalled) {
        try {
          await hooks.onPipelineEnd?.(ctx, undefined);
        } catch {
          // フック自体のエラーは無視し、元のエラーを優先して re-throw する
        }
      }
      throw error;
    }
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
    getRetryContext: () => store.get('retryContext') as import('./types').RetryContext | undefined,
    setRetryContext: (retryContext) => { store.set('retryContext', retryContext); store.set('retryReason', retryContext.reason); },
  };
}
