import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTaskContext } from '../../runner';
import { TaskContext } from '../../types';
import { handleStartApproval } from '../start-approval';
import { handleSyncMain, sanitizeSlug, WORKTREE_BASE_DIR } from '../sync-main';
import { handleImplementation } from '../implementation';
import { handlePRLifecycle } from '../pr-lifecycle';
import { handleDocUpdate } from '../doc-update';
import { handleDone } from '../done';
import { FakeNotifier } from '../../../__tests__/helpers/fake-notifier';
import { createFakeDeps, defaultReviewLoopResult } from '../../../__tests__/helpers/fake-deps';
import { GitSyncError } from '../../../git';
import { runMergePollingLoop } from '../../../merge';
import type { MergePollingResult } from '../../../merge';

// runMergePollingLoop をモック化
vi.mock('../../../merge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../merge')>();
  return { ...actual, runMergePollingLoop: vi.fn().mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 }) };
});

// detectNoRemote をモック化
// NOTE: vi.mock はホイスティングされるため、外部ヘルパーからの import は使用不可。
vi.mock('../../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../git')>();
  return { ...actual, detectNoRemote: vi.fn().mockReturnValue(false) };
});

import { detectNoRemote } from '../../../git';

// テスト用のベースコンテキストを生成するファクトリ
function makeCtx(overrides: {
  notifierOptions?: ConstructorParameters<typeof FakeNotifier>[0];
  depsOverrides?: Parameters<typeof createFakeDeps>[0];
  ctxStore?: Partial<import('../../types').TaskContextStore>;
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
      ctx.set(k as import('../../types').TaskContextKey, v as never);
    }
  }

  return { ctx, notifier };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(detectNoRemote).mockReturnValue(false);
  vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 });
});

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

// -------- sanitizeSlug --------

describe('sanitizeSlug', () => {
  it('通常の slug はそのまま返す', () => {
    expect(sanitizeSlug('my-task')).toBe('my-task');
  });

  it('パストラバーサル文字を含む slug を安全にサニタイズする', () => {
    expect(sanitizeSlug('../etc/passwd')).toBe('passwd');
  });

  it('スラッシュを含む slug は basename 部分のみ返す', () => {
    expect(sanitizeSlug('foo/bar/baz')).toBe('baz');
  });

  it('不正な文字はアンダースコアに置換する', () => {
    expect(sanitizeSlug('task with spaces')).toBe('task_with_spaces');
  });

  it('空文字列はエラーをスローする', () => {
    expect(() => sanitizeSlug('')).toThrow('Invalid slug');
  });

  it('"." のみの slug はエラーをスローする', () => {
    expect(() => sanitizeSlug('.')).toThrow('Invalid slug');
  });

  it('".." のみの slug はエラーをスローする', () => {
    expect(() => sanitizeSlug('..')).toThrow('Invalid slug');
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

  it('no-remote 検出時は警告ログを出力して continue を返す（syncMainBranch は呼ばれない）', async () => {
    vi.mocked(detectNoRemote).mockReturnValue(true);
    const syncMainBranch = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = makeCtx({ depsOverrides: { syncMainBranch } });

    const signal = await handleSyncMain(ctx);

    expect(signal.kind).toBe('continue');
    expect(syncMainBranch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('リモートリポジトリが見つかりません'),
    );

  });

  it('リモートありの場合は従来通り syncMainBranch が実行される', async () => {
    const syncMainBranch = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { syncMainBranch } });

    const signal = await handleSyncMain(ctx);

    expect(signal.kind).toBe('continue');
    expect(syncMainBranch).toHaveBeenCalledOnce();
  });

  it('worktree が作成され ctx.set("worktreePath") が呼ばれる', async () => {
    const createWorktree = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { createWorktree } });

    const signal = await handleSyncMain(ctx);

    expect(signal.kind).toBe('continue');
    expect(createWorktree).toHaveBeenCalledWith(
      '/repo',
      `${WORKTREE_BASE_DIR}/test-task`,
      'feature/test-task',
    );
    expect(ctx.get('worktreePath')).toBe(`${WORKTREE_BASE_DIR}/test-task`);
  });

  it('no-remote モードでも worktree が作成される', async () => {
    vi.mocked(detectNoRemote).mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const createWorktree = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { createWorktree } });

    const signal = await handleSyncMain(ctx);

    expect(signal.kind).toBe('continue');
    expect(createWorktree).toHaveBeenCalledWith(
      '/repo',
      `${WORKTREE_BASE_DIR}/test-task`,
      'feature/test-task',
    );
    expect(ctx.get('worktreePath')).toBe(`${WORKTREE_BASE_DIR}/test-task`);
  });

  it('worktree 作成で GitSyncError が発生すると abort を返し通知する', async () => {
    const createWorktree = vi.fn().mockRejectedValue(new GitSyncError('worktree add failed'));
    const { ctx, notifier } = makeCtx({ depsOverrides: { createWorktree } });

    const signal = await handleSyncMain(ctx);

    expect(signal.kind).toBe('abort');
    if (signal.kind === 'abort') {
      expect(signal.error).toBeInstanceOf(GitSyncError);
    }
    expect(notifier.notifications[0].message).toContain('worktree作成失敗');
  });

  it('worktree 作成で GitSyncError 以外の例外は再スローされる', async () => {
    const createWorktree = vi.fn().mockRejectedValue(new Error('unexpected worktree error'));
    const { ctx } = makeCtx({ depsOverrides: { createWorktree } });

    await expect(handleSyncMain(ctx)).rejects.toThrow('unexpected worktree error');
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

  it('worktreePath が設定されている場合、runAgent に worktreePath を cwd として渡す', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      depsOverrides: { runAgent },
      ctxStore: { worktreePath: '/tmp/autopilot/test-task' },
    });
    await handleImplementation(ctx);
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      '/tmp/autopilot/test-task',
    );
  });

  it('worktreePath が設定されている場合、runReviewLoop に worktreePath を cwd として渡す', async () => {
    const runReviewLoop = vi.fn().mockResolvedValue(defaultReviewLoopResult());
    const { ctx } = makeCtx({
      depsOverrides: { runReviewLoop },
      ctxStore: { worktreePath: '/tmp/autopilot/test-task' },
    });
    await handleImplementation(ctx);
    expect(runReviewLoop).toHaveBeenCalledWith(
      '/tmp/autopilot/test-task',
      'feature/test-task',
      'タスク内容',
    );
  });

  it('worktreePath 未設定時は repoPath にフォールバックする', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const runReviewLoop = vi.fn().mockResolvedValue(defaultReviewLoopResult());
    const { ctx } = makeCtx({ depsOverrides: { runAgent, runReviewLoop } });
    await handleImplementation(ctx);
    expect(runAgent).toHaveBeenCalledWith(expect.any(String), '/repo');
    expect(runReviewLoop).toHaveBeenCalledWith('/repo', 'feature/test-task', 'タスク内容');
  });

  it('worktreePath 設定時のプロンプトにワークツリー前提の前提条件が含まれる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      depsOverrides: { runAgent },
      ctxStore: { worktreePath: '/tmp/autopilot/test-task' },
    });
    await handleImplementation(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('ワークツリーは既に feature/test-task ブランチで作成済みです');
    expect(prompt).toContain('/tmp/autopilot/test-task');
    expect(prompt).not.toContain('直接 feature ブランチを作成してください');
  });

  it('worktreePath 未設定時のプロンプトに従来の前提条件が含まれる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleImplementation(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('直接 feature ブランチを作成してください');
    expect(prompt).not.toContain('ワークツリーは既に');
  });

  it('worktreePath 設定時の retryPrompt でも worktreePath が作業ディレクトリとして使われる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      depsOverrides: { runAgent },
      ctxStore: { worktreePath: '/tmp/autopilot/test-task' },
    });
    ctx.setRetryReason('テスト失敗');
    await handleImplementation(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('作業ディレクトリ: /tmp/autopilot/test-task');
  });
});

// -------- handlePRLifecycle --------

describe('handlePRLifecycle', () => {
  const baseCtxStore = { reviewResult: defaultReviewLoopResult() };

  it('CI成功 → MERGED検知 → continue', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'merged', elapsedMs: 5000 });
    const { ctx, notifier } = makeCtx({ ctxStore: baseCtxStore });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('continue');
    expect(ctx.get('prUrl')).toBe('https://github.com/test/repo/pull/1');
    // マージ準備完了通知が送られている
    expect(notifier.notifications.some((n) => n.message.includes('マージ準備完了'))).toBe(true);
    // マージ完了通知が送られている
    expect(notifier.notifications.some((n) => n.message.includes('マージ完了'))).toBe(true);
    // requestApproval は呼ばれない
    expect(notifier.approvalRequests).toHaveLength(0);
  });

  it('CI失敗 → retry from: implementation', async () => {
    vi.mocked(runMergePollingLoop).mockClear();
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
    // runMergePollingLoop は呼ばれない（CI失敗で早期リターン）
    expect(runMergePollingLoop).not.toHaveBeenCalled();
  });

  it('PRがCLOSED（未マージクローズ） → retry from: implementation', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'closed', elapsedMs: 3000 });
    const { ctx, notifier } = makeCtx({ ctxStore: baseCtxStore });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('retry');
    if (signal.kind === 'retry') {
      expect(signal.from).toBe('implementation');
      expect(signal.reason).toContain('クローズ');
    }
    // エラー通知が送られている
    expect(notifier.notifications.some((n) => n.message.includes('PRクローズ検知'))).toBe(true);
  });

  it('マージ待機タイムアウト → retry from: implementation', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'timeout', elapsedMs: 86400000 });
    const { ctx, notifier } = makeCtx({ ctxStore: baseCtxStore });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('retry');
    if (signal.kind === 'retry') {
      expect(signal.from).toBe('implementation');
      expect(signal.reason).toContain('タイムアウト');
    }
    expect(notifier.notifications.some((n) => n.message.includes('タイムアウト'))).toBe(true);
  });

  it('マージポーリングエラー → retry from: implementation', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'error', elapsedMs: 5000 });
    const { ctx, notifier } = makeCtx({ ctxStore: baseCtxStore });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('retry');
    if (signal.kind === 'retry') {
      expect(signal.from).toBe('implementation');
      expect(signal.reason).toContain('ポーリングエラー');
    }
    expect(notifier.notifications.some((n) => n.message.includes('ポーリングエラー'))).toBe(true);
  });

  it('no-remote 検出時はPR作成・push・CI・レビュー通知をスキップして continue を返す', async () => {
    vi.mocked(detectNoRemote).mockReturnValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execCommand = vi.fn().mockReturnValue('abc123def');
    const runCIPollingLoop = vi.fn();
    const { ctx, notifier } = makeCtx({
      ctxStore: baseCtxStore,
      depsOverrides: { execCommand, runCIPollingLoop },
    });

    const signal = await handlePRLifecycle(ctx);

    expect(signal.kind).toBe('continue');
    // git rev-parse HEAD のみ呼ばれ、push・PR作成は呼ばれない
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('git rev-parse HEAD', '/repo');
    // CI は呼ばれない
    expect(runCIPollingLoop).not.toHaveBeenCalled();
    // コンテキストにローカルオンリー情報がセットされる
    expect(ctx.get('localOnly')).toBe(true);
    expect(ctx.get('commitSha')).toBeDefined();
    expect(ctx.get('prUrl')).toBe('');
    // 通知にローカルオンリーモードが含まれる
    expect(notifier.notifications.some((n) => n.message.includes('ローカルオンリーモード'))).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PR作成・push・CI・レビュー通知をスキップ'),
    );
  });

  it('リモートありの場合はPRライフサイクル+MERGEDポーリングが実行される', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 });
    const { ctx } = makeCtx({ ctxStore: baseCtxStore });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);
    expect(signal.kind).toBe('continue');
    expect(ctx.get('prUrl')).toBe('https://github.com/test/repo/pull/1');
    expect(ctx.get('localOnly')).toBeUndefined();
    // runMergePollingLoop が呼ばれている
    expect(runMergePollingLoop).toHaveBeenCalledWith(
      'https://github.com/test/repo/pull/1',
      '/repo',
      expect.anything(),
    );
  });

  it('CI通過後にマージ準備完了の Slack 通知が送られる', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 });
    const { ctx, notifier } = makeCtx({ ctxStore: baseCtxStore });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    await handlePRLifecycle(ctx);

    const mergeReadyNotification = notifier.notifications.find((n) => n.message.includes('マージ準備完了'));
    expect(mergeReadyNotification).toBeDefined();
    expect(mergeReadyNotification!.message).toContain('GitHubから手動でマージしてください');
    expect(mergeReadyNotification!.message).toContain('https://github.com/test/repo/pull/1');
  });

  it('worktreePathが設定されている場合、マージポーリング前にクリーンアップされる', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 });
    const removeWorktreeMock = vi.fn();
    const { ctx } = makeCtx({
      ctxStore: { ...baseCtxStore, worktreePath: '/tmp/autopilot/test-task' },
      depsOverrides: { removeWorktree: removeWorktreeMock },
    });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    await handlePRLifecycle(ctx);

    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/tmp/autopilot/test-task');
    // worktreePath がクリアされている
    expect(ctx.get('worktreePath')).toBeUndefined();
  });

  it('worktreeクリーンアップが失敗してもポーリングは続行される', async () => {
    vi.mocked(runMergePollingLoop).mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const removeWorktreeMock = vi.fn().mockRejectedValue(new Error('worktree removal failed'));
    const { ctx } = makeCtx({
      ctxStore: { ...baseCtxStore, worktreePath: '/tmp/autopilot/test-task' },
      depsOverrides: { removeWorktree: removeWorktreeMock },
    });
    vi.mocked(ctx.deps.execCommand)
      .mockReturnValueOnce('')
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    const signal = await handlePRLifecycle(ctx);

    expect(signal.kind).toBe('continue');
    expect(runMergePollingLoop).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('worktreeの削除に失敗しましたが、ポーリングを続行します'),
    );
  });
});

// -------- handleDocUpdate --------

describe('handleDocUpdate', () => {
  it('成功時に continue を返す', async () => {
    const { ctx } = makeCtx();
    const signal = await handleDocUpdate(ctx);
    expect(signal.kind).toBe('continue');
  });

  it('runAgent にプロンプトと cwd を渡して呼ぶ', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(expect.any(String), '/repo');
  });

  it('worktreePath が設定されている場合、runAgent に worktreePath を cwd として渡す', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      depsOverrides: { runAgent },
      ctxStore: { worktreePath: '/tmp/autopilot/test-task' },
    });
    await handleDocUpdate(ctx);
    expect(runAgent).toHaveBeenCalledWith(
      expect.any(String),
      '/tmp/autopilot/test-task',
    );
  });

  it('プロンプトに「README に what」の旨が含まれる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('README');
    expect(prompt).toContain('何をするか（what）');
  });

  it('プロンプトに「Vault に why」の旨が含まれる（localOnly でない場合）', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('Vault');
    expect(prompt).toContain('なぜその設計か（why）');
  });

  it('プロンプトに「実装の詳細は書かない」の旨が含まれる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('実装の詳細（how）は書かない');
  });

  it('localOnly 時は Vault 更新をスキップし README のみ対象とする', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      depsOverrides: { runAgent },
      ctxStore: { localOnly: true },
    });
    await handleDocUpdate(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('README のみを対象');
    expect(prompt).not.toContain('なぜその設計か（why）');
  });

  it('localOnly でない場合は Vault も対象に含まれる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('README と Vault');
  });

  it('成功時に通知を送る', async () => {
    const { ctx, notifier } = makeCtx();
    await handleDocUpdate(ctx);
    expect(notifier.notifications.some((n) => n.message.includes('ドキュメント更新完了'))).toBe(true);
  });

  it('runAgent がエラーを投げても continue を返す（パイプラインを止めない）', async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error('agent failed'));
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    const signal = await handleDocUpdate(ctx);
    expect(signal.kind).toBe('continue');
  });

  it('エラー時に notifier で警告通知を送る', async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error('agent failed'));
    const { ctx, notifier } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    expect(notifier.notifications.some((n) => n.message.includes('ドキュメント更新失敗'))).toBe(true);
    expect(notifier.notifications.some((n) => n.message.includes('agent failed'))).toBe(true);
  });

  it('エラー時に notifier.notify が例外を投げても continue を返す（二重障害耐性）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runAgent = vi.fn().mockRejectedValue(new Error('agent failed'));
    const { ctx, notifier } = makeCtx({ depsOverrides: { runAgent } });
    // notifier.notify を上書きして例外を投げさせる
    vi.spyOn(notifier, 'notify').mockRejectedValue(new Error('notification service down'));
    const signal = await handleDocUpdate(ctx);
    expect(signal.kind).toBe('continue');
    warnSpy.mockRestore();
  });

  it('エラー時に console.warn でログ出力する', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runAgent = vi.fn().mockRejectedValue(new Error('agent failed'));
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ドキュメント更新に失敗しました'),
    );
    warnSpy.mockRestore();
  });

  it('プロンプトにタスク slug とストーリー slug が含まれる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('test-task');
    expect(prompt).toContain('test-story');
  });

  it('プロンプトにタスク内容とストーリー内容が含まれる', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('タスク内容');
    expect(prompt).toContain('ストーリー内容');
  });

  it('localOnly + worktreePath の組み合わせで正しく動作する', async () => {
    const runAgent = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      depsOverrides: { runAgent },
      ctxStore: { localOnly: true, worktreePath: '/tmp/autopilot/test-task' },
    });
    await handleDocUpdate(ctx);
    // worktreePath が cwd として使われる
    expect(runAgent).toHaveBeenCalledWith(expect.any(String), '/tmp/autopilot/test-task');
    // localOnly なので README のみ
    const prompt = runAgent.mock.calls[0][0] as string;
    expect(prompt).toContain('README のみを対象');
    expect(prompt).not.toContain('なぜその設計か（why）');
  });

  it('非 Error オブジェクトが throw されても continue を返す', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runAgent = vi.fn().mockRejectedValue('string error');
    const { ctx, notifier } = makeCtx({ depsOverrides: { runAgent } });
    const signal = await handleDocUpdate(ctx);
    expect(signal.kind).toBe('continue');
    expect(notifier.notifications.some((n) => n.message.includes('string error'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('成功時の通知にタスク slug が含まれる', async () => {
    const { ctx, notifier } = makeCtx();
    await handleDocUpdate(ctx);
    const docNotif = notifier.notifications.find((n) => n.message.includes('ドキュメント更新完了'));
    expect(docNotif).toBeDefined();
    expect(docNotif!.message).toContain('test-task');
  });

  it('エラー時の通知にタスク slug とエラーメッセージが含まれる', async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error('timeout exceeded'));
    const { ctx, notifier } = makeCtx({ depsOverrides: { runAgent } });
    await handleDocUpdate(ctx);
    const failNotif = notifier.notifications.find((n) => n.message.includes('ドキュメント更新失敗'));
    expect(failNotif).toBeDefined();
    expect(failNotif!.message).toContain('test-task');
    expect(failNotif!.message).toContain('timeout exceeded');
  });
});

// -------- handleDone --------

describe('handleDone', () => {
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

  it('リモートありの場合は recordTaskCompletion を prUrl 付きで呼ぶ', async () => {
    const { ctx } = makeCtx({
      ctxStore: { prUrl: 'https://github.com/test/repo/pull/1' },
    });
    await handleDone(ctx);
    expect(ctx.deps.recordTaskCompletion).toHaveBeenCalledWith(
      '/vault/tasks/story/task.md',
      {
        prUrl: 'https://github.com/test/repo/pull/1',
      },
    );
  });

  it('リモートありの場合は mode フィールドを設定しない', async () => {
    const { ctx } = makeCtx({
      ctxStore: { prUrl: 'https://github.com/test/repo/pull/1' },
    });
    await handleDone(ctx);
    const callArgs = vi.mocked(ctx.deps.recordTaskCompletion).mock.calls[0][1];
    expect(callArgs.mode).toBeUndefined();
  });

  it('ローカルオンリー時は recordTaskCompletion を mode: local-only で呼ぶ', async () => {
    const { ctx } = makeCtx({
      ctxStore: { localOnly: true, commitSha: 'abc123' },
    });
    await handleDone(ctx);
    expect(ctx.deps.recordTaskCompletion).toHaveBeenCalledWith(
      '/vault/tasks/story/task.md',
      {
        mode: 'local-only',
        prUrl: null,
        localCommitSha: 'abc123',
      },
    );
  });

  it('ローカルオンリー時は prUrl が null で記録される', async () => {
    const { ctx } = makeCtx({
      ctxStore: { localOnly: true, commitSha: 'abc123' },
    });
    await handleDone(ctx);
    const callArgs = vi.mocked(ctx.deps.recordTaskCompletion).mock.calls[0][1];
    expect(callArgs.prUrl).toBeNull();
  });

  it('ローカルオンリー時は localCommitSha にコミットSHAが記録される', async () => {
    const { ctx } = makeCtx({
      ctxStore: { localOnly: true, commitSha: 'def456' },
    });
    await handleDone(ctx);
    const callArgs = vi.mocked(ctx.deps.recordTaskCompletion).mock.calls[0][1];
    expect(callArgs.localCommitSha).toBe('def456');
  });

  it('ローカルオンリー時はローカルオンリー完了として通知する', async () => {
    const { ctx, notifier } = makeCtx({
      ctxStore: { localOnly: true, commitSha: 'abc123' },
    });
    const signal = await handleDone(ctx);
    expect(signal.kind).toBe('continue');
    expect(notifier.notifications[0].message).toContain('ローカルオンリー');
    expect(notifier.notifications[0].message).toContain('abc123');
    expect(notifier.notifications[0].message).toContain('PRなし');
  });

  it('リモートありの場合は通常の完了通知を送る', async () => {
    const { ctx, notifier } = makeCtx();
    await handleDone(ctx);
    expect(notifier.notifications[0].message).toContain('タスク完了');
    expect(notifier.notifications[0].message).not.toContain('ローカルオンリー');
  });

  it('worktreePath が設定されている場合は removeWorktree を呼ぶ', async () => {
    const removeWorktreeMock = vi.fn().mockResolvedValue(undefined);
    const { ctx, notifier } = makeCtx({
      ctxStore: { worktreePath: '/tmp/autopilot/test-task' },
      depsOverrides: { removeWorktree: removeWorktreeMock },
    });
    await handleDone(ctx);
    expect(removeWorktreeMock).toHaveBeenCalledWith('/repo', '/tmp/autopilot/test-task');
    // removeWorktree が完了してから後続の通知処理が実行されていることを確認
    expect(notifier.notifications.length).toBeGreaterThan(0);
  });

  it('worktreePath が未設定の場合は removeWorktree を呼ばない', async () => {
    const { ctx } = makeCtx();
    await handleDone(ctx);
    expect(ctx.deps.removeWorktree).not.toHaveBeenCalled();
  });

  it('removeWorktree が失敗してもタスク完了処理をブロックしない', async () => {
    const { ctx, notifier } = makeCtx({
      ctxStore: { worktreePath: '/tmp/autopilot/test-task' },
      depsOverrides: {
        removeWorktree: vi.fn().mockRejectedValue(new GitSyncError('worktree removal failed')),
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const signal = await handleDone(ctx);
    expect(signal.kind).toBe('continue');
    expect(notifier.notifications[0].message).toContain('タスク完了');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('worktreeの削除に失敗しました'),
    );
    warnSpy.mockRestore();
  });
});
