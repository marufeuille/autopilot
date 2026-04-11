import { trace, context, Context, SpanStatusCode } from '@opentelemetry/api';

const TRACER_NAME = 'autopilot.operation';

/**
 * Operation の種別。
 * Step 内部の個別オペレーションを識別する。
 */
export type OperationType = 'agent' | 'review' | 'ci-poll' | 'slack-approval' | 'git-sync';

/**
 * ボトルネック種別。
 * Operation の待ち時間の原因を識別する。
 */
export type WaitType = 'human' | 'ci' | 'agent';

/**
 * traceOperation に渡すオプション。
 */
export interface TraceOperationOptions {
  /** Operation の種別 */
  type: OperationType;
  /** ボトルネック種別 */
  waitType: WaitType;
}

/**
 * Operation 実行後にトークン情報やエラー情報を返すためのコールバック結果。
 */
export interface OperationResult {
  /** Claude 呼び出し時の入力トークン数 */
  tokenInput?: number;
  /** Claude 呼び出し時の出力トークン数 */
  tokenOutput?: number;
}

// --- Step Context ストア ---
// Step スパンの OTel Context を保持する。
// Pipeline のステップは逐次実行されるため、モジュールスコープで安全に管理できる。

let _currentStepContext: Context | undefined;

/**
 * 現在実行中の Step スパンの OTel Context を設定する。
 * OtelStepHooks / OtelPipelineHooks の onStepStart から呼び出される。
 */
export function setCurrentStepContext(ctx: Context | undefined): void {
  _currentStepContext = ctx;
}

/**
 * 現在の Step スパンの OTel Context を取得する。
 * テスト用にも公開する。
 */
export function getCurrentStepContext(): Context | undefined {
  return _currentStepContext;
}

/**
 * Operation スパンを生成するラッパー関数。
 *
 * Step スパンの子として Operation スパンを生成し、
 * 指定された非同期関数を実行する。
 *
 * セキュリティ設計:
 * - op.type, op.wait_type, op.error, op.token_input, op.token_output のみを記録
 * - 会話テキスト、ファイルパス、コマンド内容は一切記録しない
 *
 * @param options Operation の種別とボトルネック種別
 * @param fn 実行する非同期関数
 * @param getResult 実行結果からトークン情報を抽出するオプショナルなコールバック
 */
export async function traceOperation<T>(
  options: TraceOperationOptions,
  fn: () => Promise<T>,
  getResult?: (result: T) => OperationResult,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const parentContext = _currentStepContext ?? context.active();

  const span = tracer.startSpan(`op:${options.type}`, {
    attributes: {
      'op.type': options.type,
      'op.wait_type': options.waitType,
    },
  }, parentContext);

  try {
    const result = await fn();

    // トークン情報の記録（Claude 呼び出し時）
    // getResult コールバック内の例外は、fn() の成功結果に影響を与えないよう
    // 独立した try-catch で囲む。
    if (getResult) {
      try {
        const opResult = getResult(result);
        if (opResult.tokenInput !== undefined) {
          span.setAttribute('op.token_input', opResult.tokenInput);
        }
        if (opResult.tokenOutput !== undefined) {
          span.setAttribute('op.token_output', opResult.tokenOutput);
        }
      } catch {
        // getResult の失敗はトークン情報の記録漏れに留め、
        // 本来成功した操作の結果は呼び出し元に返す。
      }
    }

    span.setAttribute('op.error', false);
    return result;
  } catch (error) {
    span.setAttribute('op.error', true);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
