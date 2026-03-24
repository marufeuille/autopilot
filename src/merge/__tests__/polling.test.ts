import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMergePollingLoop } from '../polling';
import { MergeServiceDeps } from '../merge-service';

// sleep をモックして即座に解決させる
vi.mock('../../ci/poller', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

function createMockDeps(overrides?: Partial<MergeServiceDeps>): MergeServiceDeps {
  return {
    execGh: vi.fn().mockReturnValue(''),
    ...overrides,
  };
}

function prStatusJson(state: string): string {
  return JSON.stringify({
    state,
    mergeable: 'UNKNOWN',
    reviewDecision: '',
    statusCheckRollup: [],
  });
}

describe('runMergePollingLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('PRが最初からMERGEDの場合に finalStatus: merged を返す', async () => {
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(prStatusJson('MERGED')),
    });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 5000 },
    );

    expect(result.finalStatus).toBe('merged');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(deps.execGh).toHaveBeenCalledTimes(1);
  });

  it('PRが最初からCLOSEDの場合に finalStatus: closed を返す', async () => {
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(prStatusJson('CLOSED')),
    });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 5000 },
    );

    expect(result.finalStatus).toBe('closed');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(deps.execGh).toHaveBeenCalledTimes(1);
  });

  it('ポーリング後にMERGEDを検知する', async () => {
    const execGh = vi.fn()
      .mockReturnValueOnce(prStatusJson('OPEN'))
      .mockReturnValueOnce(prStatusJson('OPEN'))
      .mockReturnValueOnce(prStatusJson('MERGED'));

    const deps = createMockDeps({ execGh });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 60000 },
    );

    expect(result.finalStatus).toBe('merged');
    expect(execGh).toHaveBeenCalledTimes(3);
  });

  it('ポーリング後にCLOSEDを検知する', async () => {
    const execGh = vi.fn()
      .mockReturnValueOnce(prStatusJson('OPEN'))
      .mockReturnValueOnce(prStatusJson('CLOSED'));

    const deps = createMockDeps({ execGh });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 60000 },
    );

    expect(result.finalStatus).toBe('closed');
    expect(execGh).toHaveBeenCalledTimes(2);
  });

  it('タイムアウトで finalStatus: timeout を返す', async () => {
    // maxWaitMs を 0 にしてタイムアウトを即座に発生させる
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(prStatusJson('OPEN')),
    });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 0 },
    );

    expect(result.finalStatus).toBe('timeout');
  });

  it('fetchPullRequestStatus に正しい引数を渡す', async () => {
    const execGh = vi.fn().mockReturnValue(prStatusJson('MERGED'));
    const deps = createMockDeps({ execGh });

    await runMergePollingLoop(
      'https://github.com/org/repo/pull/42',
      '/my-repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 5000 },
    );

    expect(execGh).toHaveBeenCalledWith(
      ['pr', 'view', 'https://github.com/org/repo/pull/42', '--json', 'state,mergeable,reviewDecision,statusCheckRollup'],
      '/my-repo',
    );
  });

  it('デフォルトオプションが使用される（オプション未指定時）', async () => {
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(prStatusJson('MERGED')),
    });

    // オプション未指定でもエラーにならないことを確認
    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
    );

    expect(result.finalStatus).toBe('merged');
  });

  it('elapsedMs が正の値を返す', async () => {
    const execGh = vi.fn()
      .mockReturnValueOnce(prStatusJson('OPEN'))
      .mockReturnValueOnce(prStatusJson('MERGED'));

    const deps = createMockDeps({ execGh });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 60000 },
    );

    expect(result.finalStatus).toBe('merged');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
