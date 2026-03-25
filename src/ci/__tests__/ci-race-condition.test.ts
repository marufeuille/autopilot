import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// child_process をモック（gh run list / gh run view / git push）
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Claude agent SDK をモック（CI修正エージェント）
const mockQuery = vi.fn(() => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// sleep をモック（テスト高速化）
vi.mock('../poller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../poller')>();
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

import { runCIPollingLoop } from '../loop';

// ヘルパー: GitHub Actions の run を JSON 文字列で生成
function ghRunJson(
  status: string,
  conclusion: string | null,
  name = 'CI',
  databaseId = 1,
  url = 'https://github.com/test/repo/actions/runs/1',
): string {
  return JSON.stringify([{ databaseId, status, conclusion, name, url }]);
}

const EMPTY_RUNS = '[]';

describe('CI race condition 統合テスト: runCIPollingLoop → pollCIStatus → getCIStatus', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('runs 空 → CI 開始(in_progress) → CI 完了(success) で正常終了する', async () => {
    // PR 作成直後: 最初の2回は空配列、3回目に in_progress、4回目に success
    mockExecSync
      .mockReturnValueOnce(EMPTY_RUNS) // poll 1: no runs
      .mockReturnValueOnce(EMPTY_RUNS) // poll 2: no runs
      .mockReturnValueOnce(ghRunJson('in_progress', null)) // poll 3: CI started
      .mockReturnValueOnce(ghRunJson('completed', 'success')); // poll 4: CI passed

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
      emptyRunsMaxRetries: 10,
    });

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1); // CI loop の attempt は1回（CI修正なし）
    expect(result.lastCIResult?.status).toBe('success');
    expect(result.lastCIResult?.runUrl).toBe('https://github.com/test/repo/actions/runs/1');
    // 修正エージェントは呼ばれない
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('runs 空 → CI 開始(in_progress) → CI 失敗(failure) で failure を返す', async () => {
    mockExecSync
      .mockReturnValueOnce(EMPTY_RUNS) // poll 1: no runs
      .mockReturnValueOnce(ghRunJson('in_progress', null)) // poll 2: CI started
      .mockReturnValueOnce(ghRunJson('completed', 'failure')) // poll 3: CI failed
      .mockReturnValueOnce('Error: test failed') // getFailureLogs
      // 修正後の再試行（maxRetries=0 で即終了させる）
      ;

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
      emptyRunsMaxRetries: 10,
      maxRetries: 0,
    });

    expect(result.finalStatus).toBe('max_retries_exceeded');
    expect(result.attemptResults[0].ciResult.status).toBe('failure');
    expect(result.attemptResults[0].ciResult.failureLogs).toBe('Error: test failed');
  });

  it('runs が最後まで空でリトライ上限到達 → CI 未設定として success にフォールバックする', async () => {
    // 全回空配列を返す（CI 未設定のリポジトリ）
    mockExecSync.mockReturnValue(EMPTY_RUNS);

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
      emptyRunsMaxRetries: 3, // 3回で上限到達
    });

    expect(result.finalStatus).toBe('success');
    expect(result.lastCIResult?.status).toBe('success');
    expect(result.lastCIResult?.summary).toContain('No CI runs found after max retries');
    // 修正エージェントは呼ばれない
    expect(mockQuery).not.toHaveBeenCalled();
    // getCIStatus が3回呼ばれた
    expect(mockExecSync).toHaveBeenCalledTimes(3);
  });

  it('最初から runs が存在する通常フロー: in_progress → success', async () => {
    mockExecSync
      .mockReturnValueOnce(ghRunJson('in_progress', null)) // poll 1: CI running
      .mockReturnValueOnce(ghRunJson('completed', 'success')); // poll 2: CI passed

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
    });

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.lastCIResult?.status).toBe('success');
  });

  it('最初から runs が存在する通常フロー: 即 success', async () => {
    mockExecSync.mockReturnValueOnce(ghRunJson('completed', 'success'));

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
    });

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
  });

  it('最初から runs が存在する通常フロー: 即 failure → 修正 → success', async () => {
    mockExecSync
      // 1st attempt: CI failed
      .mockReturnValueOnce(ghRunJson('completed', 'failure'))
      .mockReturnValueOnce('Error log from CI') // getFailureLogs
      .mockReturnValueOnce('') // git push (pushFix)
      // 2nd attempt: CI passed
      .mockReturnValueOnce(ghRunJson('completed', 'success'));

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
      maxRetries: 3,
    });

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    expect(result.attemptResults[0].ciResult.status).toBe('failure');
    expect(result.attemptResults[0].fixDescription).toBeDefined();
    expect(result.attemptResults[1].ciResult.status).toBe('success');
    // 修正エージェントが1回呼ばれた
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('runs 空 → CI 開始 → failure → 修正 → runs 空(再CI待ち) → success の複合シナリオ', async () => {
    mockExecSync
      // 1st attempt polling: empty → CI starts → fails
      .mockReturnValueOnce(EMPTY_RUNS) // poll 1: no runs
      .mockReturnValueOnce(ghRunJson('in_progress', null)) // poll 2: CI started
      .mockReturnValueOnce(ghRunJson('completed', 'failure')) // poll 3: CI failed
      .mockReturnValueOnce('Test assertion error') // getFailureLogs
      .mockReturnValueOnce('') // git push (pushFix)
      // 2nd attempt polling: empty again (new push triggers new CI) → success
      .mockReturnValueOnce(EMPTY_RUNS) // poll 1: no runs yet (new workflow)
      .mockReturnValueOnce(ghRunJson('completed', 'success')); // poll 2: CI passed

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
      emptyRunsMaxRetries: 10,
      maxRetries: 3,
    });

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    expect(result.attemptResults[0].ciResult.status).toBe('failure');
    expect(result.attemptResults[1].ciResult.status).toBe('success');
  });

  it('emptyRunsMaxRetries=1 で即座にフォールバックする', async () => {
    mockExecSync.mockReturnValue(EMPTY_RUNS);

    const result = await runCIPollingLoop('/repo', 'feature/branch', 'task desc', {
      pollingIntervalMs: 1,
      maxWaitMs: 30000,
      emptyRunsMaxRetries: 1,
    });

    expect(result.finalStatus).toBe('success');
    expect(result.lastCIResult?.summary).toContain('No CI runs found after max retries');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });
});
