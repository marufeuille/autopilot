import { describe, it, expect, vi } from 'vitest';
import { createPipeline, createTaskContext, step } from '../runner';
import { FlowSignal, PipelineHooks, TaskContext } from '../types';

// テスト用の最小限の TaskContext を生成するヘルパー
function makeCtx(overrides: Partial<TaskContext> = {}): TaskContext {
  return createTaskContext({
    task: { filePath: '', project: '', storySlug: '', slug: 'test-task', status: 'Todo', frontmatter: {}, content: '' },
    story: { filePath: '', project: '', slug: 'test-story', status: 'Doing', frontmatter: {}, content: '' },
    repoPath: '/tmp/test',
    notifier: {
      notify: vi.fn(),
      requestApproval: vi.fn(),
      startThread: vi.fn(),
      getThreadTs: vi.fn(),
      endSession: vi.fn(),
    } as unknown as TaskContext['notifier'],
    deps: {} as TaskContext['deps'],
    ...overrides,
  });
}

// handler を1行で作るヘルパー
function handler(signal: FlowSignal) {
  return vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => signal);
}

describe('createPipeline', () => {
  it('全stepがcontinueを返すと "done" になる', async () => {
    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', handler({ kind: 'continue' })),
      step('c', handler({ kind: 'continue' })),
    ]);
    const result = await run(makeCtx());
    expect(result).toBe('done');
  });

  it('skipを返すと即座に "skipped" になり以降のstepは実行されない', async () => {
    const afterSkip = handler({ kind: 'continue' });
    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', handler({ kind: 'skip' })),
      step('c', afterSkip),
    ]);
    const result = await run(makeCtx());
    expect(result).toBe('skipped');
    expect(afterSkip).not.toHaveBeenCalled();
  });

  it('abortを返すとerrorがthrowされる', async () => {
    const error = new Error('fatal');
    const run = createPipeline([
      step('a', handler({ kind: 'abort', error })),
    ]);
    await expect(run(makeCtx())).rejects.toThrow('fatal');
  });

  it('retryを返すと指定stepに戻りretryReasonがcontextにセットされる', async () => {
    let callCount = 0;
    const retriable = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCount++;
      // 1回目はretry、2回目はcontinue
      return callCount === 1
        ? { kind: 'retry', from: 'a', reason: 'first attempt failed' }
        : { kind: 'continue' };
    });

    const stepA = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => ({ kind: 'continue' }));

    const run = createPipeline([
      step('a', stepA),
      step('b', retriable),
    ]);

    const ctx = makeCtx();
    const result = await run(ctx);

    expect(result).toBe('done');
    expect(stepA).toHaveBeenCalledTimes(2); // 最初 + retry後
    expect(retriable).toHaveBeenCalledTimes(2);
    expect(ctx.getRetryReason()).toBe('first attempt failed');
  });

  it('retryCount > maxRetries の場合に abort として処理される', async () => {
    const alwaysRetry = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => ({
      kind: 'retry', from: 'a', reason: 'always fails',
    }));

    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', alwaysRetry),
    ], { maxRetries: 3 });

    await expect(run(makeCtx())).rejects.toThrow(
      'Pipeline retry limit exceeded (3/3): last retry requested by step "b", reason: "always fails"',
    );
    // 初回 + 3回リトライ = 4回呼ばれる
    expect(alwaysRetry).toHaveBeenCalledTimes(4);
  });

  it('maxRetries未満のリトライは正常に巻き戻る', async () => {
    let callCount = 0;
    const retriable = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCount++;
      // 3回リトライして4回目でcontinue
      return callCount <= 3
        ? { kind: 'retry', from: 'a', reason: `attempt ${callCount}` }
        : { kind: 'continue' };
    });

    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', retriable),
    ], { maxRetries: 3 });

    const result = await run(makeCtx());
    expect(result).toBe('done');
  });

  it('リトライカウンターはステップをまたいで累積する', async () => {
    let stepBCalls = 0;
    let stepCCalls = 0;

    const stepB = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      stepBCalls++;
      // 1回目はretry、2回目以降はcontinue
      return stepBCalls === 1
        ? { kind: 'retry', from: 'a', reason: 'b failed' }
        : { kind: 'continue' };
    });

    const stepC = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      stepCCalls++;
      // 1回目はretry、2回目以降はcontinue
      return stepCCalls === 1
        ? { kind: 'retry', from: 'a', reason: 'c failed' }
        : { kind: 'continue' };
    });

    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', stepB),
      step('c', stepC),
    ], { maxRetries: 2 });

    // b が1回 retry、c が1回 retry → 合計2回で上限ちょうど → 成功
    const result = await run(makeCtx());
    expect(result).toBe('done');
  });

  it('ステップ累積リトライが上限を超えるとabortになる', async () => {
    let stepBCalls = 0;
    let stepCCalls = 0;

    const stepB = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      stepBCalls++;
      return stepBCalls === 1
        ? { kind: 'retry', from: 'a', reason: 'b failed' }
        : { kind: 'continue' };
    });

    const stepC = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      stepCCalls++;
      // 常にretry
      return { kind: 'retry', from: 'a', reason: 'c always fails' };
    });

    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', stepB),
      step('c', stepC),
    ], { maxRetries: 2 });

    // b: 1回retry (累積1), c: 1回retry (累積2), c: 再度retry (累積3 > 2) → abort
    await expect(run(makeCtx())).rejects.toThrow(
      'Pipeline retry limit exceeded (2/2): last retry requested by step "c", reason: "c always fails"',
    );
  });

  it('エラーメッセージにステップ名・リトライ回数・reasonが含まれる', async () => {
    const run = createPipeline([
      step('implementation', handler({ kind: 'retry', from: 'implementation', reason: 'Review NG: 型安全性の問題' })),
    ], { maxRetries: 1 });

    await expect(run(makeCtx())).rejects.toThrow('Pipeline retry limit exceeded');
    await expect(run(makeCtx())).rejects.toThrow('step "implementation"');
    await expect(run(makeCtx())).rejects.toThrow('reason: "Review NG: 型安全性の問題"');
  });

  it('maxRetriesのデフォルト値は10', async () => {
    let callCount = 0;
    const alwaysRetry = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCount++;
      return { kind: 'retry', from: 'a', reason: 'fail' };
    });

    const run = createPipeline([
      step('a', alwaysRetry),
    ]);

    await expect(run(makeCtx())).rejects.toThrow('Pipeline retry limit exceeded (10/10)');
    // 初回 + 10回リトライ + 上限超過の1回 = 11回
    expect(callCount).toBe(11);
  });

  it('存在しないstep名でretryするとエラーになる', async () => {
    const run = createPipeline([
      step('a', handler({ kind: 'retry', from: 'no-such-step', reason: 'oops' })),
    ]);
    await expect(run(makeCtx())).rejects.toThrow('Unknown step name in retry signal: "no-such-step"');
  });

  it('各stepにcontextが渡される', async () => {
    const received: TaskContext[] = [];
    const run = createPipeline([
      step('a', async (ctx) => { received.push(ctx); return { kind: 'continue' }; }),
      step('b', async (ctx) => { received.push(ctx); return { kind: 'continue' }; }),
    ]);
    const ctx = makeCtx();
    await run(ctx);
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(ctx);
    expect(received[1]).toBe(ctx);
  });
});

describe('createTaskContext', () => {
  it('get/setで値を読み書きできる', () => {
    const ctx = makeCtx();
    ctx.set('foo', 42);
    expect(ctx.get('foo')).toBe(42);
  });

  it('getRetryReason/setRetryReasonが動作する', () => {
    const ctx = makeCtx();
    expect(ctx.getRetryReason()).toBeUndefined();
    ctx.setRetryReason('need fix');
    expect(ctx.getRetryReason()).toBe('need fix');
  });

  it('未設定のキーはundefinedを返す', () => {
    const ctx = makeCtx();
    expect(ctx.get('nonexistent')).toBeUndefined();
  });
});

describe('step', () => {
  it('name と handler を持つ Step オブジェクトを返す', () => {
    const h = handler({ kind: 'continue' });
    const s = step('my-step', h);
    expect(s.name).toBe('my-step');
    expect(s.handler).toBe(h);
  });
});

describe('PipelineHooks', () => {
  function makeHooks(): { hooks: PipelineHooks; calls: string[] } {
    const calls: string[] = [];
    const hooks: PipelineHooks = {
      onPipelineStart: vi.fn(async () => { calls.push('pipeline:start'); }),
      onPipelineEnd: vi.fn(async (_ctx, result) => { calls.push(`pipeline:end:${result}`); }),
      onStepStart: vi.fn(async (_ctx, name) => { calls.push(`step:start:${name}`); }),
      onStepEnd: vi.fn(async (_ctx, info) => { calls.push(`step:end:${info.name}:${info.signal}`); }),
    };
    return { hooks, calls };
  }

  it('全stepがcontinueの場合、正しい順序でフックが呼ばれる', async () => {
    const { hooks, calls } = makeHooks();
    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', handler({ kind: 'continue' })),
    ], { hooks });

    await run(makeCtx());

    expect(calls).toEqual([
      'pipeline:start',
      'step:start:a',
      'step:end:a:continue',
      'step:start:b',
      'step:end:b:continue',
      'pipeline:end:done',
    ]);
  });

  it('skipの場合、onStepEndにsignalが渡されonPipelineEndにskippedが渡される', async () => {
    const { hooks, calls } = makeHooks();
    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', handler({ kind: 'skip' })),
      step('c', handler({ kind: 'continue' })),
    ], { hooks });

    await run(makeCtx());

    expect(calls).toEqual([
      'pipeline:start',
      'step:start:a',
      'step:end:a:continue',
      'step:start:b',
      'step:end:b:skip',
      'pipeline:end:skipped',
    ]);
  });

  it('abortの場合、onStepEndにabortが渡されonPipelineEndにundefinedが渡される', async () => {
    const { hooks, calls } = makeHooks();
    const run = createPipeline([
      step('a', handler({ kind: 'abort', error: new Error('boom') })),
    ], { hooks });

    await expect(run(makeCtx())).rejects.toThrow('boom');

    expect(calls).toEqual([
      'pipeline:start',
      'step:start:a',
      'step:end:a:abort',
      'pipeline:end:undefined',
    ]);
  });

  it('retryの場合、onStepEndにretryシグナルが渡され巻き戻し先のstepが再度フックされる', async () => {
    let callCount = 0;
    const retriable = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCount++;
      return callCount === 1
        ? { kind: 'retry', from: 'a', reason: 'fail' }
        : { kind: 'continue' };
    });

    const { hooks, calls } = makeHooks();
    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', retriable),
    ], { hooks });

    await run(makeCtx());

    expect(calls).toEqual([
      'pipeline:start',
      'step:start:a',
      'step:end:a:continue',
      'step:start:b',
      'step:end:b:retry',
      // retry → step a から再開
      'step:start:a',
      'step:end:a:continue',
      'step:start:b',
      'step:end:b:continue',
      'pipeline:end:done',
    ]);
  });

  it('フック未登録（undefined）でもパイプラインが正常動作する', async () => {
    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', handler({ kind: 'continue' })),
    ], { hooks: {} });

    const result = await run(makeCtx());
    expect(result).toBe('done');
  });

  it('hooks オプション自体を省略してもパイプラインが正常動作する', async () => {
    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
    ]);

    const result = await run(makeCtx());
    expect(result).toBe('done');
  });

  it('onStepEnd の info に step.name と step.signal が含まれる', async () => {
    const endInfos: Array<{ name: string; signal: string }> = [];
    const hooks: PipelineHooks = {
      onStepEnd: vi.fn(async (_ctx, info) => { endInfos.push(info); }),
    };

    const run = createPipeline([
      step('first', handler({ kind: 'continue' })),
      step('second', handler({ kind: 'skip' })),
    ], { hooks });

    await run(makeCtx());

    expect(endInfos).toEqual([
      { name: 'first', signal: 'continue' },
      { name: 'second', signal: 'skip' },
    ]);
  });

  it('retry上限超過時もonPipelineEndが呼ばれる', async () => {
    const { hooks, calls } = makeHooks();
    const run = createPipeline([
      step('a', handler({ kind: 'retry', from: 'a', reason: 'fail' })),
    ], { maxRetries: 1, hooks });

    await expect(run(makeCtx())).rejects.toThrow('Pipeline retry limit exceeded');

    // onPipelineEnd が undefined（エラー）で呼ばれることを確認
    expect(calls).toContain('pipeline:end:undefined');
  });
});
