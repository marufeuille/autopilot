import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { OtelPipelineHooks, createPipelineHooksIfEnabled } from '../hooks';
import { createTaskContext } from '../../pipeline/runner';
import type { TaskContext, PipelineResult } from '../../pipeline/types';

// テスト用の最小限の TaskContext を生成するヘルパー
function makeCtx(overrides: Partial<Pick<TaskContext, 'task' | 'story'>> = {}): TaskContext {
  return createTaskContext({
    task: {
      filePath: '',
      project: 'test-project',
      storySlug: '',
      slug: 'test-task',
      status: 'Todo',
      frontmatter: {},
      content: '',
      ...overrides.task,
    },
    story: {
      filePath: '',
      project: 'test-project',
      slug: 'test-story',
      status: 'Doing',
      frontmatter: {},
      content: '',
      ...overrides.story,
    },
    repoPath: '/tmp/test',
    notifier: {
      notify: vi.fn(),
      requestApproval: vi.fn(),
      startThread: vi.fn(),
      getThreadTs: vi.fn(),
      endSession: vi.fn(),
    } as unknown as TaskContext['notifier'],
    deps: {} as TaskContext['deps'],
  });
}

describe('OtelPipelineHooks', () => {
  let hooks: OtelPipelineHooks;

  beforeEach(() => {
    hooks = new OtelPipelineHooks();
  });

  it('onPipelineStart で Task スパンが生成され task.slug が属性に設定される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    // 新しいインスタンスで getTracer のモックを反映
    hooks = new OtelPipelineHooks();
    const ctx = makeCtx({ task: { slug: 'my-task' } as any });

    await hooks.onPipelineStart(ctx);

    expect(mockTracer.startSpan).toHaveBeenCalledWith('task', {
      attributes: { 'task.slug': 'my-task', 'task.project': 'test-project' },
    });
  });

  it('onPipelineStart で task.project 属性が設定される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx({ task: { slug: 'my-task', project: 'stash' } as any });

    await hooks.onPipelineStart(ctx);

    expect(mockTracer.startSpan).toHaveBeenCalledWith('task', {
      attributes: expect.objectContaining({ 'task.project': 'stash' }),
    });
  });

  it('onPipelineEnd で Task スパンに task.result が設定されスパンが終了する', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onPipelineEnd(ctx, 'done');

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('task.result', 'done');
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('onPipelineEnd で result が undefined の場合 ERROR ステータスが設定される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onPipelineEnd(ctx, undefined);

    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('onStepStart で Step スパンが Task スパンの子として生成され step.name が設定される', async () => {
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockStepSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskContext = {} as any;
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockTaskSpan)   // onPipelineStart
        .mockReturnValueOnce(mockStepSpan),  // onStepStart
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(mockTaskContext);

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onStepStart(ctx, 'implementation');

    // Step スパンが Task コンテキストを親として生成される
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'step:implementation',
      { attributes: { 'step.name': 'implementation' } },
      mockTaskContext,
    );
  });

  it('onStepEnd で step.signal が属性に設定されスパンが終了する', async () => {
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockStepSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockTaskSpan)
        .mockReturnValueOnce(mockStepSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onStepStart(ctx, 'sync-main');
    await hooks.onStepEnd(ctx, { name: 'sync-main', signal: 'continue' });

    expect(mockStepSpan.setAttribute).toHaveBeenCalledWith('step.signal', 'continue');
    expect(mockStepSpan.end).toHaveBeenCalled();
  });

  it('onStepEnd で signal が abort の場合 ERROR ステータスが設定される', async () => {
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockStepSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockTaskSpan)
        .mockReturnValueOnce(mockStepSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onStepStart(ctx, 'sync-main');
    await hooks.onStepEnd(ctx, { name: 'sync-main', signal: 'abort' });

    expect(mockStepSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });

  it('同名ステップが未終了の場合、防御的に前のスパンを終了してから新しいスパンを開始する', async () => {
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockStepSpan1 = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockStepSpan2 = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockTaskSpan)
        .mockReturnValueOnce(mockStepSpan1)
        .mockReturnValueOnce(mockStepSpan2),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onStepStart(ctx, 'same-step');
    // onStepEnd を呼ばずに同名ステップを再開始
    await hooks.onStepStart(ctx, 'same-step');

    // 前のスパンが防御的に終了されている
    expect(mockStepSpan1.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'step overwritten before end',
    });
    expect(mockStepSpan1.end).toHaveBeenCalled();
  });

  it('onPipelineStart 前に onStepStart を呼んでも例外が発生しない', async () => {
    const ctx = makeCtx();
    await expect(hooks.onStepStart(ctx, 'test')).resolves.toBeUndefined();
  });

  it('onPipelineStart 前に onStepEnd を呼んでも例外が発生しない', async () => {
    const ctx = makeCtx();
    await expect(hooks.onStepEnd(ctx, { name: 'test', signal: 'continue' })).resolves.toBeUndefined();
  });

  it('onPipelineStart 前に onPipelineEnd を呼んでも例外が発生しない', async () => {
    const ctx = makeCtx();
    await expect(hooks.onPipelineEnd(ctx, 'done')).resolves.toBeUndefined();
  });

  it('skipped 結果で onPipelineEnd が正しく動作する', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onPipelineEnd(ctx, 'skipped');

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('task.result', 'skipped');
    expect(mockSpan.setStatus).not.toHaveBeenCalled();
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('全ライフサイクルが正しい順序で動作する（2 step シナリオ）', async () => {
    const calls: string[] = [];
    let startSpanCallCount = 0;

    const mockTaskSpan = {
      setAttribute: vi.fn((k: string, v: string) => calls.push(`task:attr:${k}=${v}`)),
      setStatus: vi.fn(),
      end: vi.fn(() => calls.push('task:end')),
    };

    const makeStepSpan = () => ({
      setAttribute: vi.fn((k: string, v: string) => calls.push(`step:attr:${k}=${v}`)),
      setStatus: vi.fn(),
      end: vi.fn(() => calls.push('step:end')),
    });

    const mockTracer = {
      startSpan: vi.fn((..._args: any[]) => {
        startSpanCallCount++;
        if (startSpanCallCount === 1) {
          calls.push('task:start');
          return mockTaskSpan;
        }
        calls.push('step:start');
        return makeStepSpan();
      }),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx();

    await hooks.onPipelineStart(ctx);
    await hooks.onStepStart(ctx, 'step-a');
    await hooks.onStepEnd(ctx, { name: 'step-a', signal: 'continue' });
    await hooks.onStepStart(ctx, 'step-b');
    await hooks.onStepEnd(ctx, { name: 'step-b', signal: 'continue' });
    await hooks.onPipelineEnd(ctx, 'done');

    expect(calls).toEqual([
      'task:start',
      'step:start',
      'step:attr:step.signal=continue',
      'step:end',
      'step:start',
      'step:attr:step.signal=continue',
      'step:end',
      'task:attr:task.result=done',
      'task:end',
    ]);
  });

  it('スパンに会話テキスト・ファイルパス・コマンド内容・環境変数が含まれない', async () => {
    const setAttributeCalls: Array<[string, any]> = [];
    const mockSpan = {
      setAttribute: vi.fn((k: string, v: any) => setAttributeCalls.push([k, v])),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelPipelineHooks();
    const ctx = makeCtx({
      task: {
        filePath: '/secret/path/task.md',
        project: 'my-project',
        storySlug: 'my-story',
        slug: 'my-task',
        status: 'Todo',
        frontmatter: { secret: 'value' },
        content: 'This is secret conversation content',
      } as any,
    });

    await hooks.onPipelineStart(ctx);
    await hooks.onStepStart(ctx, 'implementation');
    await hooks.onStepEnd(ctx, { name: 'implementation', signal: 'continue' });
    await hooks.onPipelineEnd(ctx, 'done');

    // 許可されたキーのリスト
    const allowedKeys = new Set([
      'task.slug', 'task.project', 'task.result',
      'step.name', 'step.signal',
    ]);

    // startSpan の attributes を検証
    const allStartSpanCalls = mockTracer.startSpan.mock.calls;
    for (const call of allStartSpanCalls) {
      const attrs = call[1]?.attributes ?? {};
      for (const [key, value] of Object.entries(attrs)) {
        expect(allowedKeys).toContain(key);
        expect(String(value)).not.toContain('/secret/path');
        expect(String(value)).not.toContain('secret conversation');
      }
    }

    // setAttribute 呼び出しを検証
    for (const [key, value] of setAttributeCalls) {
      expect(allowedKeys).toContain(key);
      expect(String(value)).not.toContain('/secret/path');
      expect(String(value)).not.toContain('secret conversation');
    }
  });
});

describe('createPipelineHooksIfEnabled', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('OTEL_ENABLED=true の場合 OtelPipelineHooks を返す', () => {
    process.env.OTEL_ENABLED = 'true';
    const hooks = createPipelineHooksIfEnabled();
    expect(hooks).toBeInstanceOf(OtelPipelineHooks);
  });

  it('OTEL_ENABLED=false の場合 undefined を返す', () => {
    process.env.OTEL_ENABLED = 'false';
    const hooks = createPipelineHooksIfEnabled();
    expect(hooks).toBeUndefined();
  });

  it('OTEL_ENABLED 未設定の場合 undefined を返す', () => {
    delete process.env.OTEL_ENABLED;
    const hooks = createPipelineHooksIfEnabled();
    expect(hooks).toBeUndefined();
  });
});
