import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMergePollingLoop } from '../polling';
import { MergeServiceDeps } from '../merge-service';
import { MergeError } from '../types';
import { signalRejection, _resetForTest } from '../rejection-registry';
import { sleep } from '../../ci/poller';

// sleep をモックして即座に解決させる
vi.mock('../../ci/poller', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

const mockedSleep = vi.mocked(sleep);

/**
 * 手動制御の Deferred Promise を作成する。
 * テスト内で非同期処理のタイミングを明示的に制御するために使用。
 */
function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

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
    _resetForTest();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
    // ループ先頭の elapsed >= maxWait チェックで 0 >= 0 が常に成立するため決定的
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
    // タイムアウトチェックが fetchPullRequestStatus より先に実行されるため、
    // execGh は呼ばれない
    expect(deps.execGh).not.toHaveBeenCalled();
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

  // --- エラーハンドリングのテスト ---

  it('一時的なエラーが発生してもリトライして次のポーリングを続行する', async () => {
    const execGh = vi.fn()
      .mockImplementationOnce(() => { throw new MergeError('unknown', 'network error', 500); })
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
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('連続エラーが上限に達したら finalStatus: error を返す', async () => {
    const execGh = vi.fn().mockImplementation(() => {
      throw new MergeError('unknown', 'gh CLI timeout', 500);
    });

    const deps = createMockDeps({ execGh });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 60000, maxConsecutiveErrors: 3 },
    );

    expect(result.finalStatus).toBe('error');
    expect(execGh).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('エラー後に成功すると連続エラーカウントがリセットされる', async () => {
    const execGh = vi.fn()
      .mockImplementationOnce(() => { throw new Error('error 1'); })
      .mockImplementationOnce(() => { throw new Error('error 2'); })
      .mockReturnValueOnce(prStatusJson('OPEN'))  // 成功 → カウントリセット
      .mockImplementationOnce(() => { throw new Error('error 3'); })
      .mockImplementationOnce(() => { throw new Error('error 4'); })
      .mockReturnValueOnce(prStatusJson('MERGED')); // 成功

    const deps = createMockDeps({ execGh });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 60000, maxConsecutiveErrors: 3 },
    );

    expect(result.finalStatus).toBe('merged');
    expect(execGh).toHaveBeenCalledTimes(6);
    // エラーは4回発生したが、連続では最大2回なので上限(3)に達しない
    expect(console.warn).toHaveBeenCalledTimes(4);
  });

  it('Error以外の例外でもハンドリングされる', async () => {
    const execGh = vi.fn()
      .mockImplementationOnce(() => { throw 'string error'; }) // eslint-disable-line no-throw-literal
      .mockReturnValueOnce(prStatusJson('MERGED'));

    const deps = createMockDeps({ execGh });

    const result = await runMergePollingLoop(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { pollingIntervalMs: 100, maxWaitMs: 60000 },
    );

    expect(result.finalStatus).toBe('merged');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  // --- バリデーションのテスト ---

  it('pollingIntervalMs が負の値の場合にエラーをスローする', async () => {
    const deps = createMockDeps();

    await expect(
      runMergePollingLoop('https://github.com/org/repo/pull/1', '/repo', deps, {
        pollingIntervalMs: -1,
        maxWaitMs: 5000,
      }),
    ).rejects.toThrow('pollingIntervalMs must be a positive finite number');
  });

  it('pollingIntervalMs が 0 の場合にエラーをスローする', async () => {
    const deps = createMockDeps();

    await expect(
      runMergePollingLoop('https://github.com/org/repo/pull/1', '/repo', deps, {
        pollingIntervalMs: 0,
        maxWaitMs: 5000,
      }),
    ).rejects.toThrow('pollingIntervalMs must be a positive finite number');
  });

  it('pollingIntervalMs が NaN の場合にエラーをスローする', async () => {
    const deps = createMockDeps();

    await expect(
      runMergePollingLoop('https://github.com/org/repo/pull/1', '/repo', deps, {
        pollingIntervalMs: NaN,
        maxWaitMs: 5000,
      }),
    ).rejects.toThrow('pollingIntervalMs must be a positive finite number');
  });

  it('pollingIntervalMs が Infinity の場合にエラーをスローする', async () => {
    const deps = createMockDeps();

    await expect(
      runMergePollingLoop('https://github.com/org/repo/pull/1', '/repo', deps, {
        pollingIntervalMs: Infinity,
        maxWaitMs: 5000,
      }),
    ).rejects.toThrow('pollingIntervalMs must be a positive finite number');
  });

  it('maxWaitMs が負の値の場合にエラーをスローする', async () => {
    const deps = createMockDeps();

    await expect(
      runMergePollingLoop('https://github.com/org/repo/pull/1', '/repo', deps, {
        pollingIntervalMs: 100,
        maxWaitMs: -1,
      }),
    ).rejects.toThrow('maxWaitMs must be a non-negative finite number');
  });

  it('maxWaitMs が NaN の場合にエラーをスローする', async () => {
    const deps = createMockDeps();

    await expect(
      runMergePollingLoop('https://github.com/org/repo/pull/1', '/repo', deps, {
        pollingIntervalMs: 100,
        maxWaitMs: NaN,
      }),
    ).rejects.toThrow('maxWaitMs must be a non-negative finite number');
  });

  // --- rejection シグナルのテスト ---

  it('ポーリング中に signalRejection が呼ばれると finalStatus: rejected と rejectionReason が返る', async () => {
    const prUrl = 'https://github.com/org/repo/pull/100';
    const execGh = vi.fn().mockReturnValue(prStatusJson('OPEN'));
    const deps = createMockDeps({ execGh });

    // sleep を手動 Promise で制御し、ポーリングの進行を明示的に管理する。
    // これにより sleep が呼ばれるタイミングへの依存を排除する。
    const sleepDeferred = createDeferred();
    mockedSleep.mockImplementation(() => sleepDeferred.promise);

    const resultPromise = runMergePollingLoop(prUrl, '/repo', deps, {
      pollingIntervalMs: 100,
      maxWaitMs: 60000,
    });

    // マイクロタスクを消化してポーリングが sleep に到達するのを待つ
    await Promise.resolve();

    // rejection シグナルを送信（sleep が未解決なのでポーリングはブロック中）
    signalRejection(prUrl, 'テストが不十分です');

    const result = await resultPromise;

    expect(result.finalStatus).toBe('rejected');
    expect(result.rejectionReason).toBe('テストが不十分です');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // クリーンアップ: sleep Promise を解決してポーリングループの停止を促す
    sleepDeferred.resolve();
  });

  it('ポーリング側が先に完了した場合（MERGED）は従来と同じ結果が返り、registry がクリーンアップされる', async () => {
    const prUrl = 'https://github.com/org/repo/pull/101';
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(prStatusJson('MERGED')),
    });

    const result = await runMergePollingLoop(prUrl, '/repo', deps, {
      pollingIntervalMs: 100,
      maxWaitMs: 5000,
    });

    expect(result.finalStatus).toBe('merged');
    expect(result.rejectionReason).toBeUndefined();

    // クリーンアップされているので signalRejection はバッファリングされる（false を返す）
    const signaled = signalRejection(prUrl, '遅延シグナル');
    expect(signaled).toBe(false);
  });

  it('ポーリング側が先に完了した場合（CLOSED）も registry がクリーンアップされる', async () => {
    const prUrl = 'https://github.com/org/repo/pull/102';
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(prStatusJson('CLOSED')),
    });

    const result = await runMergePollingLoop(prUrl, '/repo', deps, {
      pollingIntervalMs: 100,
      maxWaitMs: 5000,
    });

    expect(result.finalStatus).toBe('closed');

    // クリーンアップ確認
    const signaled = signalRejection(prUrl, '遅延シグナル');
    expect(signaled).toBe(false);
  });

  it('rejection 理由が空文字でも正しく返る', async () => {
    const prUrl = 'https://github.com/org/repo/pull/103';
    const execGh = vi.fn().mockReturnValue(prStatusJson('OPEN'));
    const deps = createMockDeps({ execGh });

    // sleep を手動 Promise で制御
    const sleepDeferred = createDeferred();
    mockedSleep.mockImplementation(() => sleepDeferred.promise);

    const resultPromise = runMergePollingLoop(prUrl, '/repo', deps, {
      pollingIntervalMs: 100,
      maxWaitMs: 60000,
    });

    await Promise.resolve();
    signalRejection(prUrl, '');

    const result = await resultPromise;

    expect(result.finalStatus).toBe('rejected');
    expect(result.rejectionReason).toBe('');

    sleepDeferred.resolve();
  });

  it('タイムアウト時も registry がクリーンアップされる', async () => {
    const prUrl = 'https://github.com/org/repo/pull/104';
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(prStatusJson('OPEN')),
    });

    // maxWaitMs: 0 はループ先頭の elapsed >= maxWait チェックで即座にタイムアウトする
    // （elapsed は必ず 0 以上なので、0 >= 0 が常に成立する）
    const result = await runMergePollingLoop(prUrl, '/repo', deps, {
      pollingIntervalMs: 100,
      maxWaitMs: 0,
    });

    expect(result.finalStatus).toBe('timeout');
    // タイムアウトチェックが先に実行されるため execGh は呼ばれない
    expect(deps.execGh).not.toHaveBeenCalled();

    // クリーンアップ確認
    const signaled = signalRejection(prUrl, '遅延シグナル');
    expect(signaled).toBe(false);
  });

  it('ポーリング開始前にシグナルが送信されていた場合でも rejected が返る', async () => {
    const prUrl = 'https://github.com/org/repo/pull/105';
    const execGh = vi.fn().mockReturnValue(prStatusJson('OPEN'));
    const deps = createMockDeps({ execGh });

    // ポーリング開始前にシグナルを送信（バッファリングされる）
    signalRejection(prUrl, '先行 rejection');

    const result = await runMergePollingLoop(prUrl, '/repo', deps, {
      pollingIntervalMs: 100,
      maxWaitMs: 60000,
    });

    expect(result.finalStatus).toBe('rejected');
    expect(result.rejectionReason).toBe('先行 rejection');
  });
});
