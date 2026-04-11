import { trace, Span, context, SpanStatusCode, Context } from '@opentelemetry/api';
import type { PipelineHooks, TaskContext, StepEndInfo, PipelineResult, StepName } from '../pipeline/types';

const TRACER_NAME = 'autopilot.pipeline';

/**
 * OTel 計装を PipelineHooks として実装するクラス。
 *
 * onPipelineStart で Task スパン（root）を開始し、
 * onStepStart / onStepEnd で子スパンを開始・終了する。
 *
 * セキュリティ設計:
 * - 会話テキスト、ファイルパス、コマンド内容、環境変数は一切記録しない
 * - slug 名やシグナル種別など、構造的な識別子のみを属性に設定する
 */
export class OtelPipelineHooks implements PipelineHooks {
  private readonly tracer = trace.getTracer(TRACER_NAME);
  private taskSpan: Span | undefined;
  private taskContext: Context | undefined;
  private stepSpan: Span | undefined;

  async onPipelineStart(ctx: TaskContext): Promise<void> {
    this.taskSpan = this.tracer.startSpan('task', {
      attributes: {
        'task.slug': ctx.task.slug,
      },
    });
    this.taskContext = trace.setSpan(context.active(), this.taskSpan);
  }

  async onPipelineEnd(_ctx: TaskContext, result: PipelineResult | undefined): Promise<void> {
    if (!this.taskSpan) return;

    if (result) {
      this.taskSpan.setAttribute('task.result', result);
    } else {
      this.taskSpan.setStatus({ code: SpanStatusCode.ERROR });
    }
    this.taskSpan.end();
    this.taskSpan = undefined;
    this.taskContext = undefined;
  }

  async onStepStart(_ctx: TaskContext, stepName: StepName): Promise<void> {
    if (!this.taskContext) return;

    this.stepSpan = this.tracer.startSpan(
      `step:${stepName}`,
      { attributes: { 'step.name': stepName } },
      this.taskContext,
    );
  }

  async onStepEnd(_ctx: TaskContext, info: StepEndInfo): Promise<void> {
    if (!this.stepSpan) return;

    this.stepSpan.setAttribute('step.signal', info.signal);
    if (info.signal === 'abort') {
      this.stepSpan.setStatus({ code: SpanStatusCode.ERROR });
    }
    this.stepSpan.end();
    this.stepSpan = undefined;
  }
}

/**
 * OTEL_ENABLED 環境変数に基づいて PipelineHooks を返す。
 * OTEL_ENABLED=true の場合のみ OtelPipelineHooks を返し、
 * それ以外は undefined を返す（フック未登録 = no-op）。
 */
export function createPipelineHooksIfEnabled(): PipelineHooks | undefined {
  if (process.env.OTEL_ENABLED !== 'true') {
    return undefined;
  }
  return new OtelPipelineHooks();
}
