import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { OtelOrchestratorHooks, OtelStepHooks, createOrchestratorHooksIfEnabled } from '../hooks';
import { createTaskContext } from '../../pipeline/runner';
import type { TaskContext } from '../../pipeline/types';
import type { StoryFile, TaskFile } from '../../vault/reader';

function makeStory(overrides: Partial<StoryFile> = {}): StoryFile {
  return {
    filePath: '',
    project: 'test-project',
    slug: 'test-story',
    status: 'Doing',
    frontmatter: {},
    content: '',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    filePath: '',
    project: 'test-project',
    storySlug: 'test-story',
    slug: 'test-task',
    status: 'Todo',
    frontmatter: { effort: 'medium', priority: 'high' },
    content: '',
    ...overrides,
  };
}

function makeCtx(): TaskContext {
  return createTaskContext({
    task: makeTask(),
    story: makeStory(),
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

describe('OtelOrchestratorHooks', () => {
  let hooks: OtelOrchestratorHooks;

  beforeEach(() => {
    hooks = new OtelOrchestratorHooks();
  });

  it('onStoryStart で Story スパンが生成され story.slug, story.task_count が属性に設定される', async () => {
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

    hooks = new OtelOrchestratorHooks();
    const story = makeStory({ slug: 'my-story' });

    await hooks.onStoryStart(story, { taskCount: 3 });

    expect(mockTracer.startSpan).toHaveBeenCalledWith('story', {
      attributes: {
        'story.slug': 'my-story',
        'story.task_count': 3,
      },
    });
  });

  it('onStoryEnd で story.result が属性に設定されスパンが終了する', async () => {
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

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onStoryEnd(story, 'Done');

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('story.result', 'Done');
    expect(mockSpan.setStatus).not.toHaveBeenCalled();
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('onStoryEnd で result が Failed の場合 ERROR ステータスが設定される', async () => {
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

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onStoryEnd(story, 'Failed');

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('story.result', 'Failed');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });

  it('onStoryEnd で result が Cancelled の場合 ERROR ステータスが設定される', async () => {
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

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onStoryEnd(story, 'Cancelled');

    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });

  it('onTaskStart で Task スパンが Story スパンの子として生成される', async () => {
    const mockStorySpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockStoryContext = { _type: 'story-context' } as any;
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockStorySpan)  // onStoryStart
        .mockReturnValueOnce(mockTaskSpan),  // onTaskStart
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(mockStoryContext);

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask({ slug: 'my-task', frontmatter: { effort: 'medium', priority: 'high' } });

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);

    // Task スパンが Story コンテキストを親として生成される
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'task',
      {
        attributes: {
          'task.slug': 'my-task',
          'task.effort': 'medium',
          'task.priority': 'high',
        },
      },
      mockStoryContext,
    );
  });

  it('onTaskEnd で task.result, task.retry_count が属性に設定されスパンが終了する', async () => {
    const mockStorySpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockStorySpan)
        .mockReturnValueOnce(mockTaskSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);
    await hooks.onTaskEnd(task, story, 'done', { retryCount: 2 });

    expect(mockTaskSpan.setAttribute).toHaveBeenCalledWith('task.result', 'done');
    expect(mockTaskSpan.setAttribute).toHaveBeenCalledWith('task.retry_count', 2);
    expect(mockTaskSpan.end).toHaveBeenCalled();
  });

  it('onTaskEnd で result が failed の場合 ERROR ステータスが設定される', async () => {
    const mockStorySpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockStorySpan)
        .mockReturnValueOnce(mockTaskSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);
    await hooks.onTaskEnd(task, story, 'failed', { retryCount: 0 });

    expect(mockTaskSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });

  it('getPipelineHooks が Task コンテキストを親とする OtelStepHooks を返す', async () => {
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

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);

    const pipelineHooks = hooks.getPipelineHooks();
    expect(pipelineHooks).toBeInstanceOf(OtelStepHooks);
  });

  it('getPipelineHooks が onTaskStart 前は undefined を返す', () => {
    expect(hooks.getPipelineHooks()).toBeUndefined();
  });

  it('onStoryStart 前に onStoryEnd を呼んでも例外が発生しない', async () => {
    const story = makeStory();
    await expect(hooks.onStoryEnd(story, 'Done')).resolves.toBeUndefined();
  });

  it('onTaskStart 前に onTaskEnd を呼んでも例外が発生しない', async () => {
    const task = makeTask();
    const story = makeStory();
    await expect(hooks.onTaskEnd(task, story, 'done', { retryCount: 0 })).resolves.toBeUndefined();
  });

  it('未終了の Task スパンが onStoryEnd 時に防御的に終了される', async () => {
    const mockStorySpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockStorySpan)
        .mockReturnValueOnce(mockTaskSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);
    // onTaskEnd を呼ばずに onStoryEnd
    await hooks.onStoryEnd(story, 'Done');

    expect(mockTaskSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'task not ended before story end',
    });
    expect(mockTaskSpan.end).toHaveBeenCalled();
    expect(mockStorySpan.end).toHaveBeenCalled();
  });

  it('未終了の Task スパンが onTaskStart 時に防御的に終了される', async () => {
    const mockStorySpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskSpan1 = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskSpan2 = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockStorySpan)
        .mockReturnValueOnce(mockTaskSpan1)
        .mockReturnValueOnce(mockTaskSpan2),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task1 = makeTask({ slug: 'task-1' });
    const task2 = makeTask({ slug: 'task-2' });

    await hooks.onStoryStart(story, { taskCount: 2 });
    await hooks.onTaskStart(task1, story);
    // onTaskEnd を呼ばずに次のタスクを開始
    await hooks.onTaskStart(task2, story);

    expect(mockTaskSpan1.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'task overwritten before end',
    });
    expect(mockTaskSpan1.end).toHaveBeenCalled();
  });

  it('effort/priority が未設定の場合でも空文字が設定される', async () => {
    const mockStorySpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTaskSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn()
        .mockReturnValueOnce(mockStorySpan)
        .mockReturnValueOnce(mockTaskSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask({ frontmatter: {} }); // effort/priority 未設定

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'task.effort': '',
          'task.priority': '',
        }),
      }),
      expect.anything(),
    );
  });

  it('全ライフサイクルが正しい順序で動作する（Story → Task → Step シナリオ）', async () => {
    const calls: string[] = [];
    let startSpanCallCount = 0;

    const mockStorySpan = {
      setAttribute: vi.fn((k: string, v: unknown) => calls.push(`story:attr:${k}=${v}`)),
      setStatus: vi.fn(),
      end: vi.fn(() => calls.push('story:end')),
    };
    const mockTaskSpan = {
      setAttribute: vi.fn((k: string, v: unknown) => calls.push(`task:attr:${k}=${v}`)),
      setStatus: vi.fn(),
      end: vi.fn(() => calls.push('task:end')),
    };
    const mockStepSpan = {
      setAttribute: vi.fn((k: string, v: unknown) => calls.push(`step:attr:${k}=${v}`)),
      setStatus: vi.fn(),
      end: vi.fn(() => calls.push('step:end')),
    };

    const mockTracer = {
      startSpan: vi.fn((..._args: any[]) => {
        startSpanCallCount++;
        if (startSpanCallCount === 1) {
          calls.push('story:start');
          return mockStorySpan;
        }
        if (startSpanCallCount === 2) {
          calls.push('task:start');
          return mockTaskSpan;
        }
        calls.push('step:start');
        return { ...mockStepSpan }; // 各ステップは別インスタンス
      }),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();
    const ctx = makeCtx();

    // Story → Task → Step → Step → Task end → Story end
    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);

    const pipelineHooks = hooks.getPipelineHooks()!;
    await pipelineHooks.onPipelineStart!(ctx);
    await pipelineHooks.onStepStart!(ctx, 'implementation');
    await pipelineHooks.onStepEnd!(ctx, { name: 'implementation', signal: 'continue' });
    await pipelineHooks.onPipelineEnd!(ctx, 'done');

    await hooks.onTaskEnd(task, story, 'done', { retryCount: 0 });
    await hooks.onStoryEnd(story, 'Done');

    expect(calls).toEqual([
      'story:start',
      'task:start',
      // pipeline start is no-op in OtelStepHooks
      'step:start',
      'step:attr:step.signal=continue',
      'step:end',
      // pipeline end cleans up (no remaining steps here)
      'task:attr:task.result=done',
      'task:attr:task.retry_count=0',
      'task:end',
      'story:attr:story.result=Done',
      'story:end',
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

    hooks = new OtelOrchestratorHooks();
    const story = makeStory({
      filePath: '/secret/vault/stories/my-story.md',
      slug: 'my-story',
      content: 'Secret story content',
      frontmatter: { secret_key: 'secret_value' },
    });
    const task = makeTask({
      filePath: '/secret/vault/tasks/my-task.md',
      slug: 'my-task',
      content: 'Secret task content with commands',
      frontmatter: { effort: 'large', priority: 'critical', api_key: 'sk-1234' },
    });

    await hooks.onStoryStart(story, { taskCount: 2 });
    await hooks.onTaskStart(task, story);
    await hooks.onTaskEnd(task, story, 'done', { retryCount: 1 });
    await hooks.onStoryEnd(story, 'Done');

    // startSpan に渡された attributes も検証
    const allStartSpanCalls = mockTracer.startSpan.mock.calls;
    for (const call of allStartSpanCalls) {
      const attrs = call[1]?.attributes ?? {};
      for (const [key, value] of Object.entries(attrs)) {
        // 許可されたキーのみ
        expect([
          'story.slug', 'story.task_count',
          'task.slug', 'task.effort', 'task.priority',
        ]).toContain(key);
        // ファイルパス・コンテンツが値に含まれない
        expect(String(value)).not.toContain('/secret');
        expect(String(value)).not.toContain('Secret');
        expect(String(value)).not.toContain('sk-1234');
      }
    }

    // setAttribute 呼び出しも検証
    const allKeys = setAttributeCalls.map(([k]) => k);
    const allValues = setAttributeCalls.map(([_, v]) => String(v));

    for (const key of allKeys) {
      expect([
        'story.slug', 'story.task_count', 'story.result',
        'task.slug', 'task.effort', 'task.priority', 'task.result', 'task.retry_count',
        'step.name', 'step.signal',
      ]).toContain(key);
    }

    for (const value of allValues) {
      expect(value).not.toContain('/secret');
      expect(value).not.toContain('Secret');
      expect(value).not.toContain('sk-1234');
    }
  });
});

describe('OtelStepHooks', () => {
  it('onPipelineStart は no-op', async () => {
    const mockTracer = {
      startSpan: vi.fn(),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    const stepHooks = new OtelStepHooks(mockTracer as any, context.active());
    const ctx = makeCtx();

    await stepHooks.onPipelineStart!(ctx);

    // startSpan は呼ばれない（Task スパンは orchestrator が管理）
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  it('onStepStart で Step スパンが parentContext を親として生成される', async () => {
    const mockStepSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockParentContext = { _type: 'task-context' } as any;
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockStepSpan),
    };

    const stepHooks = new OtelStepHooks(mockTracer as any, mockParentContext);
    const ctx = makeCtx();

    await stepHooks.onStepStart!(ctx, 'sync-main');

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'step:sync-main',
      { attributes: { 'step.name': 'sync-main' } },
      mockParentContext,
    );
  });

  it('onPipelineEnd で未終了のステップスパンが防御的に終了される', async () => {
    const mockStepSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockStepSpan),
    };

    const stepHooks = new OtelStepHooks(mockTracer as any, context.active());
    const ctx = makeCtx();

    await stepHooks.onStepStart!(ctx, 'implementation');
    // onStepEnd を呼ばずに onPipelineEnd
    await stepHooks.onPipelineEnd!(ctx, 'done');

    expect(mockStepSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'step not ended before pipeline end',
    });
    expect(mockStepSpan.end).toHaveBeenCalled();
  });
});

describe('createOrchestratorHooksIfEnabled', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('OTEL_ENABLED=true の場合 OtelOrchestratorHooks を返す', () => {
    process.env.OTEL_ENABLED = 'true';
    const hooks = createOrchestratorHooksIfEnabled();
    expect(hooks).toBeInstanceOf(OtelOrchestratorHooks);
  });

  it('OTEL_ENABLED=false の場合 undefined を返す', () => {
    process.env.OTEL_ENABLED = 'false';
    const hooks = createOrchestratorHooksIfEnabled();
    expect(hooks).toBeUndefined();
  });

  it('OTEL_ENABLED 未設定の場合 undefined を返す', () => {
    delete process.env.OTEL_ENABLED;
    const hooks = createOrchestratorHooksIfEnabled();
    expect(hooks).toBeUndefined();
  });
});
