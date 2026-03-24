import { describe, it, expect, vi } from 'vitest';
import { createPipeline, createTaskContext, step } from '../runner';
import { FlowSignal, TaskContext } from '../types';

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

  it('存在しないstep名でretryするとエラーになる', async () => {
    const run = createPipeline([
      step('a', handler({ kind: 'retry', from: 'no-such-step', reason: 'oops' })),
    ]);
    await expect(run(makeCtx())).rejects.toThrow('Unknown step name in retry signal: "no-such-step"');
  });

  it('リトライ上限超過時にabortとしてエラーがthrowされる', async () => {
    const maxRetries = 3;
    const alwaysRetry = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => ({
      kind: 'retry', from: 'a', reason: 'always fails',
    }));

    const run = createPipeline([
      step('a', alwaysRetry),
    ], { maxRetries });

    await expect(run(makeCtx())).rejects.toThrow(
      'Pipeline retry limit exceeded (4/3): last retry requested by step "a", reason: "always fails"',
    );
    // 初回 + maxRetries回のリトライ = maxRetries + 1 回呼ばれる
    expect(alwaysRetry).toHaveBeenCalledTimes(maxRetries + 1);
  });

  it('リトライカウンターはステップをまたいで累積する', async () => {
    const maxRetries = 3;
    let callCountB = 0;
    let callCountC = 0;

    // step b: 2回retryしてからcontinue
    const stepB = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCountB++;
      return callCountB <= 2
        ? { kind: 'retry', from: 'a', reason: 'retry from b' }
        : { kind: 'continue' };
    });

    // step c: さらに2回retry → 累積4回で上限(3)超過
    const stepC = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCountC++;
      return { kind: 'retry', from: 'a', reason: 'retry from c' };
    });

    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', stepB),
      step('c', stepC),
    ], { maxRetries });

    await expect(run(makeCtx())).rejects.toThrow(
      'Pipeline retry limit exceeded',
    );
  });

  it('maxRetries未満のリトライは正常に巻き戻る', async () => {
    let callCount = 0;
    const retriable = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCount++;
      return callCount <= 3
        ? { kind: 'retry', from: 'a', reason: `attempt ${callCount}` }
        : { kind: 'continue' };
    });

    const run = createPipeline([
      step('a', handler({ kind: 'continue' })),
      step('b', retriable),
    ], { maxRetries: 5 });

    const result = await run(makeCtx());
    expect(result).toBe('done');
    expect(retriable).toHaveBeenCalledTimes(4); // 3回retry + 1回continue
  });

  it('maxRetriesのデフォルト値は10である', async () => {
    let callCount = 0;
    const alwaysRetry = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
      callCount++;
      return { kind: 'retry', from: 'a', reason: 'fail' };
    });

    const run = createPipeline([
      step('a', alwaysRetry),
    ]); // options なし → デフォルト10

    await expect(run(makeCtx())).rejects.toThrow(
      'Pipeline retry limit exceeded (11/10)',
    );
    expect(alwaysRetry).toHaveBeenCalledTimes(11); // 初回 + 10回リトライ + 上限超過の1回
  });

  it('エラーメッセージにステップ名・リトライ回数・reasonが含まれる', async () => {
    const run = createPipeline([
      step('implementation', handler({ kind: 'retry', from: 'implementation', reason: 'Review NG: 型安全性の問題' })),
    ], { maxRetries: 1 });

    await expect(run(makeCtx())).rejects.toThrow(
      'Pipeline retry limit exceeded (2/1): last retry requested by step "implementation", reason: "Review NG: 型安全性の問題"',
    );
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
