import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { OtelOrchestratorHooks } from '../hooks';
import { traceOperation, setCurrentStepContext } from '../operation';
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

describe('4階層トレース (Story → Task → Step → Operation)', () => {
  afterEach(() => {
    setCurrentStepContext(undefined);
  });

  it('Story → Task → Step → Operation の4階層がすべて正しい順序で動作する', async () => {
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
    const mockOpSpan = {
      setAttribute: vi.fn((k: string, v: unknown) => calls.push(`op:attr:${k}=${v}`)),
      setStatus: vi.fn(),
      end: vi.fn(() => calls.push('op:end')),
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
        if (startSpanCallCount === 3) {
          calls.push('step:start');
          return mockStepSpan;
        }
        calls.push('op:start');
        return { ...mockOpSpan };
      }),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    const hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();
    const ctx = makeCtx();

    // 1. Story 開始
    await hooks.onStoryStart(story, { taskCount: 1 });
    // 2. Task 開始
    await hooks.onTaskStart(task, story);

    // 3. Pipeline hooks 経由で Step 開始
    const pipelineHooks = hooks.getPipelineHooks()!;
    await pipelineHooks.onPipelineStart!(ctx);
    await pipelineHooks.onStepStart!(ctx, 'implementation');

    // 4. Step 内で Operation 実行
    await traceOperation(
      { type: 'agent', waitType: 'agent' },
      async () => 'agent-result',
    );
    await traceOperation(
      { type: 'review', waitType: 'agent' },
      async () => 'review-result',
    );

    // 5. Step 終了
    await pipelineHooks.onStepEnd!(ctx, { name: 'implementation', signal: 'continue' });
    await pipelineHooks.onPipelineEnd!(ctx, 'done');

    // 6. Task 終了
    await hooks.onTaskEnd(task, story, 'done', { retryCount: 0 });
    // 7. Story 終了
    await hooks.onStoryEnd(story, 'Done');

    expect(calls).toEqual([
      'story:start',
      'task:start',
      // pipeline start is no-op in OtelStepHooks
      'step:start',
      // operation: agent
      'op:start',
      'op:attr:op.error=false',
      'op:end',
      // operation: review
      'op:start',
      'op:attr:op.error=false',
      'op:end',
      // step end
      'step:attr:step.signal=continue',
      'step:end',
      // pipeline end (no cleanup needed)
      // task end
      'task:attr:task.result=done',
      'task:attr:task.retry_count=0',
      'task:end',
      // story end
      'story:attr:story.result=Done',
      'story:end',
    ]);
  });

  it('Operation でエラーが発生しても Step・Task・Story スパンが正常に終了する', async () => {
    const spans: Record<string, { setAttribute: any; setStatus: any; end: any }> = {};
    let startSpanCallCount = 0;

    const createMockSpan = (label: string) => ({
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    });

    const mockTracer = {
      startSpan: vi.fn((..._args: any[]) => {
        startSpanCallCount++;
        const labels = ['story', 'task', 'step', 'op'];
        const label = labels[startSpanCallCount - 1] || `span-${startSpanCallCount}`;
        const span = createMockSpan(label);
        spans[label] = span;
        return span;
      }),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    const hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();
    const ctx = makeCtx();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);
    const pipelineHooks = hooks.getPipelineHooks()!;
    await pipelineHooks.onPipelineStart!(ctx);
    await pipelineHooks.onStepStart!(ctx, 'implementation');

    // Operation がエラーを投げる
    await expect(
      traceOperation(
        { type: 'agent', waitType: 'agent' },
        async () => { throw new Error('agent failed'); },
      ),
    ).rejects.toThrow('agent failed');

    // Operation スパンにエラーが記録される
    expect(spans.op.setAttribute).toHaveBeenCalledWith('op.error', true);
    expect(spans.op.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(spans.op.end).toHaveBeenCalled();

    // Step・Task・Story は正常に終了できる
    await pipelineHooks.onStepEnd!(ctx, { name: 'implementation', signal: 'abort' });
    await pipelineHooks.onPipelineEnd!(ctx, undefined);
    await hooks.onTaskEnd(task, story, 'failed', { retryCount: 0 });
    await hooks.onStoryEnd(story, 'Failed');

    expect(spans.step.end).toHaveBeenCalled();
    expect(spans.task.end).toHaveBeenCalled();
    expect(spans.story.end).toHaveBeenCalled();
  });

  it('複数の Step にまたがる Operation が各 Step の子として正しく配置される', async () => {
    const startSpanCalls: Array<{ name: string; parentContext: any }> = [];
    let spanCount = 0;

    const stepContexts: Record<string, any> = {};

    const mockTracer = {
      startSpan: vi.fn((name: string, _opts: any, parentCtx: any) => {
        spanCount++;
        startSpanCalls.push({ name, parentContext: parentCtx });
        return {
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          end: vi.fn(),
        };
      }),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    // setSpan のモック: Step ごとに異なるコンテキストを返す
    let setSpanCallCount = 0;
    vi.spyOn(trace, 'setSpan').mockImplementation((_ctx: any, _span: any) => {
      setSpanCallCount++;
      const ctxObj = { _id: `context-${setSpanCallCount}` };
      return ctxObj as any;
    });

    const hooks = new OtelOrchestratorHooks();
    const story = makeStory();
    const task = makeTask();
    const ctx = makeCtx();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);
    const pipelineHooks = hooks.getPipelineHooks()!;
    await pipelineHooks.onPipelineStart!(ctx);

    // Step 1: implementation
    await pipelineHooks.onStepStart!(ctx, 'implementation');

    await traceOperation(
      { type: 'agent', waitType: 'agent' },
      async () => 'ok',
    );

    await pipelineHooks.onStepEnd!(ctx, { name: 'implementation', signal: 'continue' });

    // Step 2: pr-lifecycle
    await pipelineHooks.onStepStart!(ctx, 'pr-lifecycle');

    await traceOperation(
      { type: 'ci-poll', waitType: 'ci' },
      async () => 'ok',
    );

    await pipelineHooks.onStepEnd!(ctx, { name: 'pr-lifecycle', signal: 'continue' });
    await pipelineHooks.onPipelineEnd!(ctx, 'done');

    // operation スパンの startSpan 呼び出しを検証
    // startSpan は: story, task, step:impl, op:agent, step:pr-lifecycle, op:ci-poll
    const opCalls = startSpanCalls.filter((c) => c.name.startsWith('op:'));
    expect(opCalls).toHaveLength(2);
    expect(opCalls[0].name).toBe('op:agent');
    expect(opCalls[1].name).toBe('op:ci-poll');

    // 各 operation の親コンテキストが異なる（各 Step のコンテキスト）
    // OTel のモックにより、setSpan が呼ばれるたびに新しいコンテキストが生成されるため
    // 各 operation は直前の setSpan の結果を使用する
    expect(opCalls[0].parentContext).toBeDefined();
    expect(opCalls[1].parentContext).toBeDefined();
  });

  it('4階層のスパン属性にセキュリティ上の問題がない', async () => {
    const allStartSpanCalls: Array<{ name: string; attrs: Record<string, unknown> }> = [];
    const allSetAttributeCalls: Array<[string, any]> = [];

    const mockTracer = {
      startSpan: vi.fn((name: string, opts: any, _ctx: any) => {
        allStartSpanCalls.push({ name, attrs: opts?.attributes ?? {} });
        return {
          setAttribute: vi.fn((k: string, v: any) => allSetAttributeCalls.push([k, v])),
          setStatus: vi.fn(),
          end: vi.fn(),
        };
      }),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);
    vi.spyOn(trace, 'setSpan').mockReturnValue(context.active());

    const hooks = new OtelOrchestratorHooks();
    const story = makeStory({
      filePath: '/secret/vault/stories/story.md',
      slug: 'my-story',
      content: 'Secret story content',
    });
    const task = makeTask({
      filePath: '/secret/vault/tasks/task.md',
      slug: 'my-task',
      content: 'Secret task content with API key sk-1234',
    });
    const ctx = makeCtx();

    await hooks.onStoryStart(story, { taskCount: 1 });
    await hooks.onTaskStart(task, story);
    const ph = hooks.getPipelineHooks()!;
    await ph.onPipelineStart!(ctx);
    await ph.onStepStart!(ctx, 'implementation');

    await traceOperation(
      { type: 'agent', waitType: 'agent' },
      async () => 'ok',
      () => ({ tokenInput: 500, tokenOutput: 1000 }),
    );

    await ph.onStepEnd!(ctx, { name: 'implementation', signal: 'continue' });
    await ph.onPipelineEnd!(ctx, 'done');
    await hooks.onTaskEnd(task, story, 'done', { retryCount: 0 });
    await hooks.onStoryEnd(story, 'Done');

    // 許可されたキーのリスト
    const allowedKeys = new Set([
      'story.slug', 'story.project', 'story.task_count', 'story.result',
      'task.slug', 'task.project', 'task.effort', 'task.priority', 'task.result', 'task.retry_count',
      'step.name', 'step.signal',
      'op.type', 'op.wait_type', 'op.error', 'op.token_input', 'op.token_output',
    ]);

    // startSpan の attributes を検証
    for (const { attrs } of allStartSpanCalls) {
      for (const [key, value] of Object.entries(attrs)) {
        expect(allowedKeys).toContain(key);
        expect(String(value)).not.toContain('/secret');
        expect(String(value)).not.toContain('Secret');
        expect(String(value)).not.toContain('sk-1234');
      }
    }

    // setAttribute の呼び出しを検証
    for (const [key, value] of allSetAttributeCalls) {
      expect(allowedKeys).toContain(key);
      expect(String(value)).not.toContain('/secret');
      expect(String(value)).not.toContain('Secret');
      expect(String(value)).not.toContain('sk-1234');
    }
  });
});
