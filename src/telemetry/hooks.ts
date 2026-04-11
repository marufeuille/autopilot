import { trace, Span, context, SpanStatusCode, Context, Tracer } from '@opentelemetry/api';
import type { PipelineHooks, TaskContext, StepEndInfo, PipelineResult, StepName, OrchestratorHooks, TaskResult } from '../pipeline/types';
import type { StoryFile, StoryStatus, TaskFile } from '../vault/reader';
import { setCurrentStepContext } from './operation';

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
  private readonly stepSpans = new Map<StepName, Span>();

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

    // 未終了のステップスパンを防御的に終了する
    for (const [name, span] of this.stepSpans) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'step not ended before pipeline end' });
      span.end();
      this.stepSpans.delete(name);
    }

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

    // 同名ステップが未終了の場合は防御的に終了してからリークを防ぐ
    const existing = this.stepSpans.get(stepName);
    if (existing) {
      existing.setStatus({ code: SpanStatusCode.ERROR, message: 'step overwritten before end' });
      existing.end();
    }

    const span = this.tracer.startSpan(
      `step:${stepName}`,
      { attributes: { 'step.name': stepName } },
      this.taskContext,
    );
    this.stepSpans.set(stepName, span);

    // Operation スパンの親コンテキストとして Step スパンを設定
    const stepContext = trace.setSpan(this.taskContext, span);
    setCurrentStepContext(stepContext);
  }

  async onStepEnd(_ctx: TaskContext, info: StepEndInfo): Promise<void> {
    const span = this.stepSpans.get(info.name);
    if (!span) return;

    span.setAttribute('step.signal', info.signal);
    if (info.signal === 'abort') {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
    this.stepSpans.delete(info.name);

    // Step 終了時に Operation 用コンテキストをクリア
    setCurrentStepContext(undefined);
  }
}

/**
 * Step スパンのみを生成する PipelineHooks 実装。
 * OrchestratorHooks が Task スパンを管理する場合に使用する。
 * Task スパンの Context を親として Step スパンを生成する。
 */
export class OtelStepHooks implements PipelineHooks {
  private readonly stepSpans = new Map<StepName, Span>();

  constructor(
    private readonly tracer: Tracer,
    private readonly parentContext: Context,
  ) {}

  async onPipelineStart(_ctx: TaskContext): Promise<void> {
    // Task スパンは OrchestratorHooks が管理するため no-op
  }

  async onPipelineEnd(_ctx: TaskContext, _result: PipelineResult | undefined): Promise<void> {
    // 未終了のステップスパンを防御的に終了する
    for (const [name, span] of this.stepSpans) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'step not ended before pipeline end' });
      span.end();
      this.stepSpans.delete(name);
    }
  }

  async onStepStart(_ctx: TaskContext, stepName: StepName): Promise<void> {
    const existing = this.stepSpans.get(stepName);
    if (existing) {
      existing.setStatus({ code: SpanStatusCode.ERROR, message: 'step overwritten before end' });
      existing.end();
    }

    const span = this.tracer.startSpan(
      `step:${stepName}`,
      { attributes: { 'step.name': stepName } },
      this.parentContext,
    );
    this.stepSpans.set(stepName, span);

    // Operation スパンの親コンテキストとして Step スパンを設定
    const stepContext = trace.setSpan(this.parentContext, span);
    setCurrentStepContext(stepContext);
  }

  async onStepEnd(_ctx: TaskContext, info: StepEndInfo): Promise<void> {
    const span = this.stepSpans.get(info.name);
    if (!span) return;

    span.setAttribute('step.signal', info.signal);
    if (info.signal === 'abort') {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
    this.stepSpans.delete(info.name);

    // Step 終了時に Operation 用コンテキストをクリア
    setCurrentStepContext(undefined);
  }
}

/**
 * OTel 計装を OrchestratorHooks として実装するクラス。
 *
 * Story → Task → Step の3階層トレースを実現する。
 * - onStoryStart で Story スパン（root）を開始
 * - onTaskStart で Task スパンを Story の子として開始
 * - getPipelineHooks で Task スパンを親とする Step フックを返す
 *
 * セキュリティ設計:
 * - 会話テキスト、ファイルパス、コマンド内容、環境変数は一切記録しない
 * - slug 名やステータスなど、構造的な識別子のみを属性に設定する
 */
export class OtelOrchestratorHooks implements OrchestratorHooks {
  private readonly tracer = trace.getTracer(TRACER_NAME);
  private storySpan: Span | undefined;
  private storyContext: Context | undefined;
  private taskSpan: Span | undefined;
  private taskContext: Context | undefined;

  async onStoryStart(_story: StoryFile, info: { taskCount: number }): Promise<void> {
    this.storySpan = this.tracer.startSpan('story', {
      attributes: {
        'story.slug': _story.slug,
        'story.task_count': info.taskCount,
      },
    });
    this.storyContext = trace.setSpan(context.active(), this.storySpan);
  }

  async onStoryEnd(_story: StoryFile, result: StoryStatus): Promise<void> {
    // 未終了の Task スパンを防御的に終了する
    if (this.taskSpan) {
      this.taskSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'task not ended before story end' });
      this.taskSpan.end();
      this.taskSpan = undefined;
      this.taskContext = undefined;
    }

    if (!this.storySpan) return;

    this.storySpan.setAttribute('story.result', result);
    if (result === 'Failed' || result === 'Cancelled') {
      this.storySpan.setStatus({ code: SpanStatusCode.ERROR });
    }
    this.storySpan.end();
    this.storySpan = undefined;
    this.storyContext = undefined;
  }

  async onTaskStart(task: TaskFile, _story: StoryFile): Promise<void> {
    // 未終了の Task スパンを防御的に終了する
    if (this.taskSpan) {
      this.taskSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'task overwritten before end' });
      this.taskSpan.end();
    }

    const parentContext = this.storyContext ?? context.active();
    this.taskSpan = this.tracer.startSpan('task', {
      attributes: {
        'task.slug': task.slug,
        'task.effort': String(task.frontmatter.effort ?? ''),
        'task.priority': String(task.frontmatter.priority ?? ''),
      },
    }, parentContext);
    this.taskContext = trace.setSpan(parentContext, this.taskSpan);
  }

  async onTaskEnd(
    _task: TaskFile,
    _story: StoryFile,
    result: TaskResult,
    info: { retryCount: number },
  ): Promise<void> {
    if (!this.taskSpan) return;

    this.taskSpan.setAttribute('task.result', result);
    this.taskSpan.setAttribute('task.retry_count', info.retryCount);
    if (result === 'failed') {
      this.taskSpan.setStatus({ code: SpanStatusCode.ERROR });
    }
    this.taskSpan.end();
    this.taskSpan = undefined;
    this.taskContext = undefined;
  }

  getPipelineHooks(): PipelineHooks | undefined {
    if (!this.taskContext) return undefined;
    return new OtelStepHooks(this.tracer, this.taskContext);
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

/**
 * OTEL_ENABLED 環境変数に基づいて OrchestratorHooks を返す。
 * OTEL_ENABLED=true の場合のみ OtelOrchestratorHooks を返し、
 * それ以外は undefined を返す（フック未登録 = no-op）。
 */
export function createOrchestratorHooksIfEnabled(): OrchestratorHooks | undefined {
  if (process.env.OTEL_ENABLED !== 'true') {
    return undefined;
  }
  return new OtelOrchestratorHooks();
}
