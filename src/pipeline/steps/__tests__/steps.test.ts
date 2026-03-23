import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskContext } from '../../runner';
import { TaskContext } from '../../types';
import { handleStartApproval } from '../start-approval';
import { handleSyncMain } from '../sync-main';
import { handleImplementation } from '../implementation';
import { handlePRLifecycle } from '../pr-lifecycle';
import { handleDone } from '../done';
import { FakeNotifier } from '../../../__tests__/helpers/fake-notifier';
import { createFakeDeps, defaultReviewLoopResult } from '../../../__tests__/helpers/fake-deps';
import { GitSyncError } from '../../../git';
import { MergeError } from '../../../merge';

// テスト用のベースコンテキストを生成するファクトリ
function makeCtx(overrides: {
  notifierOptions?: ConstructorParameters<typeof FakeNotifier>[0];
  depsOverrides?: Parameters<typeof createFakeDeps>[0];
  ctxStore?: Record<string, unknown>;
} = {}): { ctx: TaskContext; notifier: FakeNotifier } {
  const notifier = new FakeNotifier(overrides.notifierOptions);
  const deps = createFakeDeps(overrides.depsOverrides);
  const ctx = createTaskContext({
    task: {
      filePath: '/vault/tasks/story/task.md',
      project: 'test-project',
      storySlug: 'test-story',
      slug: 'test-task',
      status: 'Todo',
      frontmatter: {},
      content: 'タスク内容',
    },
    story: {
      filePath: '/vault/stories/story.md',
      project: 'test-project',
      slug: 'test-story',
      status: 'Doing',
      frontmatter: {},
      content: 'ストーリー内容',
    },
    repoPath: '/repo',
    notifier,
    deps,
  });

  // ctxStore を事前にセット
  if (overrides.ctxStore) {
    for (const [k, v] of Object.entries(overrides.ctxStore)) {
      ctx.set(k, v);
    }
  }

  return { ctx, notifier };
}

// -------- handleStartApproval --------

describe('handleStartApproval', () => {
  it('承認されると continue を返す', async () => {
    const { ctx } = makeCtx({
      notifierOptions: { approvalResponses: [{ action: 'approve' }] },
    });
    const signal = await handleStartApproval(ctx);
    expect(signal.kind).toBe('continue');
  });

  it('拒否されると skip を返す', async () => {
    const { ctx } = makeCtx({
      notifierOptions: { approvalResponses: [{ action: 'reject', reason: 'later' }] },
    });
    const signal = await handleStartApproval(ctx);
    expect(signal.kind).toBe('skip');
  });

  it('requestApproval が呼ばれること', async () => {
    const { ctx, notifier } = makeCtx();
    await handleStartApproval(ctx);
    expect(notifier.approvalRequests).toHaveLength(1);
    expect(notifier.approvalRequests[0].message).toContain('タスク開始確認');
  });
});

// -------- handleSyncMain --------

describe('handleSyncMain', () => {
  it('syncMainBranch が成功すると continue を返す', async () => {
    const { ctx } = makeCtx();
    const signal = await handleSyncMain(ctx);
    expect(signal.kind).toBe('continue');
  });

  it('GitSyncError が発生すると abort を返し通知する', async () => {
    const { ctx, notifier } = makeCtx({
      depsOverrides: {
        syncMainBranch: vi.fn().mockRejectedValue(new GitSyncError('pull failed')),
      },
    });
    const signal = await handleSyncMain(ctx);
    expect(signal.kind).toBe('abort');
    if (signal.kind === 'abort') {
      expect(signal.error).toBeInstanceOf(GitSyncError);
    }
    expect(notifier.notifications[0].message).toContain('main同期失敗');
  });

  it('GitSyncError 以外の例外は再スローされる', async () => {
    const { ctx } = makeCtx({
      depsOverrides: {
        syncMainBranch: vi.fn().mockRejectedValue(new Error('unexpected')),
      },
    });
    await expect(handleSyncMain(ctx)).rejects.toThrow('unexpected');
  });
});

// -------- handleImplementation --------

describe('handleImplementation', () => {
  it('レビューOK → reviewResult をセットして continue', async () => {
    const reviewResult = defaultReviewLoopResult();
    const { ctx } = makeCtx({
      depsOverrides: {
        runReviewLoop: vi.fn().mockResolvedValue(reviewResult),
      },
    });
    const signal = await handleImplementation(ctx);
    expect(signal.kind).toBe('continue');
    expect(ctx.get('reviewResult')).toBe(reviewResult);
  });

  it('レビューNG(非escalation) → retry from: implementation', async () => {
    const { ctx } = makeCtx({
      depsOverrides: {
        runReviewLoop: vi.fn().mockResolvedValue({
          finalVerdict: 'NG',
          escalationRequired: false,
          iterations: [],
          lastReviewResult: { verdict: 'NG', summary: 'bad', findings: [] },
        }),
      },
    });
    const signal = await handleImplementation(ctx);
    expect(signal.kind).toBe('retry');
    if (signal.kind === 'retry') {
      expect(signal.from).toBe('implementation');
    }
  });

  it('レビューNG(escalation) → retry from: implementation かつエスカレーション通知', async () => {
    const { ctx, notifier } = makeCtx({
      depsOverrides: {
        runReviewLoop: vi.fn().mockResolvedValue({
          finalVerdict: 'NG',
          escalationRequired: true,
          iterations: [],
          lastReviewResult: { verdict: 'NG', summary: 'escalated', findings: [] },
        }),
      },
    });
    const signal = await handleImplementation(ctx);
    expect(signal.kind).toBe('retry');
    const escalationNotif = notifier.notifications.find((n) =>
      n.message.includes('エスカレーション'),
    );
    expect(escalationNotif).toBeDefined();
  });

  it('retryReason があればリトライ用プロンプトでエージェントを呼ぶ', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    ctx.setRetryReason('CIが失敗しました');
    await handleImplementation(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('修正依頼');
    expect(prompt).toContain('CIが失敗しました');
  });

  it('retryReason がなければ初回プロンプトでエージェントを呼ぶ', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleImplementation(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('実装してください');
    expect(prompt).not.toContain('修正依頼');
  });
});

// -------- handlePRLifecycle --------

describe('handlePRLifecycle', () => {
  const baseCtxStore = { reviewResult: defaultReviewLoopResult() };

  it('CI成功 → マージ承認 → マージ成功 → continue', async () => {
    const { ctx } = makeCtx({ ctxStore: baseCtxStore });
    // execCommand: push成功 + pr create成功
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('continue');
    expect(ctx.get('prUrl')).toBe('https://github.com/test/repo/pull/1');
  });

  it('CI失敗 → retry from: implementation', async () => {
    const { ctx } = makeCtx({
      ctxStore: baseCtxStore,
      depsOverrides: {
        runCIPollingLoop: vi.fn().mockResolvedValue({
          finalStatus: 'failure',
          attempts: 1,
          attemptResults: [],
          lastCIResult: { status: 'failure', summary: 'build failed' },
        }),
      },
    });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('retry');
    if (signal.kind === 'retry') {
      expect(signal.from).toBe('implementation');
    }
  });

  it('マージ承認が拒否された → retry from: implementation', async () => {
    const { ctx } = makeCtx({
      ctxStore: baseCtxStore,
      notifierOptions: {
        approvalResponses: [{ action: 'reject', reason: '実装を見直して' }],
      },
    });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('retry');
    if (signal.kind === 'retry') {
      expect(signal.from).toBe('implementation');
      expect(signal.reason).toBe('実装を見直して');
    }
  });

  it('マージ失敗(MergeError) → retry from: pr-lifecycle', async () => {
    const mergeError = new MergeError('merge_conflict', 'conflict', 409);
    const { ctx } = makeCtx({
      ctxStore: baseCtxStore,
      depsOverrides: {
        execGh: vi.fn().mockImplementation((args: string[]) => {
          if (args.includes('merge')) throw mergeError;
          if (args.includes('view') && args.includes('--json')) {
            return JSON.stringify({
              state: 'OPEN',
              mergeable: 'CONFLICTING',
              reviewDecision: 'APPROVED',
              statusCheckRollup: [],
            });
          }
          return '';
        }),
      },
    });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('retry');
    if (signal.kind === 'retry') {
      expect(signal.from).toBe('pr-lifecycle');
    }
  });
});

// -------- handleDone --------

describe('handleDone', () => {
  it('updateFileStatus(Done) を呼ぶ', async () => {
    const { ctx } = makeCtx();
    await handleDone(ctx);
    expect(ctx.deps.updateFileStatus).toHaveBeenCalledWith(
      '/vault/tasks/story/task.md',
      'Done',
    );
  });

  it('完了通知を送る', async () => {
    const { ctx, notifier } = makeCtx();
    await handleDone(ctx);
    expect(notifier.notifications[0].message).toContain('タスク完了');
  });

  it('continue を返す', async () => {
    const { ctx } = makeCtx();
    const signal = await handleDone(ctx);
    expect(signal.kind).toBe('continue');
  });
});
