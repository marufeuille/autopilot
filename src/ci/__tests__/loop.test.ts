import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CIRunResult } from '../types';

// child_process をモック
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Claude agent SDK をモック
const mockQuery = vi.fn(() => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// poller をモック
const mockPollCIStatus = vi.fn();
const mockHasCIWorkflows = vi.fn().mockReturnValue(true);
vi.mock('../poller', () => ({
  pollCIStatus: (...args: unknown[]) => mockPollCIStatus(...args),
  hasCIWorkflows: (...args: unknown[]) => mockHasCIWorkflows(...args),
}));

import {
  runCIPollingLoop,
  formatCIPollingResult,
  buildCIFixPrompt,
  pushFix,
} from '../loop';
import { CIPollingError, CIPollingTimeoutError, CIPollingResult } from '../types';

function successResult(summary = 'CI: completed (success)'): CIRunResult {
  return {
    status: 'success',
    summary,
    runUrl: 'https://github.com/test/repo/actions/runs/1',
  };
}

function failureResult(summary = 'CI: completed (failure)'): CIRunResult {
  return {
    status: 'failure',
    summary,
    failureLogs: 'Error: test failed\n  at test.ts:42',
    runUrl: 'https://github.com/test/repo/actions/runs/1',
  };
}

describe('runCIPollingLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReturnValue(''); // git push default
  });

  it('ワークフローファイルが存在しない場合は即座に no_ci を返す', async () => {
    mockHasCIWorkflows.mockReturnValueOnce(false);

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    expect(result.finalStatus).toBe('no_ci');
    expect(result.attempts).toBe(0);
    expect(result.attemptResults).toHaveLength(0);
    expect(mockPollCIStatus).not.toHaveBeenCalled();
  });

  it('CI が最初に成功した場合、試行1回で終了する', async () => {
    mockPollCIStatus.mockResolvedValueOnce(successResult());

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.attemptResults).toHaveLength(1);
    expect(result.attemptResults[0].ciResult.status).toBe('success');
    expect(result.attemptResults[0].fixDescription).toBeUndefined();
  });

  it('CI 失敗→修正→CI 成功でループが終了する', async () => {
    mockPollCIStatus
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(successResult());

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    expect(result.attemptResults).toHaveLength(2);
    // 1回目: 失敗 + 修正あり
    expect(result.attemptResults[0].ciResult.status).toBe('failure');
    expect(result.attemptResults[0].fixDescription).toBeDefined();
    // 2回目: 成功
    expect(result.attemptResults[1].ciResult.status).toBe('success');
    // 修正エージェントが1回呼ばれた
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // git push が1回呼ばれた
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git push origin feature/task-01'),
      expect.any(Object),
    );
  });

  it('最大リトライ到達で max_retries_exceeded を返す', async () => {
    mockPollCIStatus
      .mockResolvedValueOnce(failureResult('fail 1'))
      .mockResolvedValueOnce(failureResult('fail 2'))
      .mockResolvedValueOnce(failureResult('fail 3'))
      .mockResolvedValueOnce(failureResult('fail 4'));

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc', {
      maxRetries: 3,
    });

    expect(result.finalStatus).toBe('max_retries_exceeded');
    expect(result.attemptResults).toHaveLength(4);
    // 修正エージェントは3回（最後の失敗では修正しない）
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('maxRetries=0 の場合、1回だけ CI を確認して結果を返す', async () => {
    mockPollCIStatus.mockResolvedValueOnce(failureResult());

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc', {
      maxRetries: 0,
    });

    expect(result.finalStatus).toBe('max_retries_exceeded');
    expect(result.attempts).toBe(1);
    expect(mockQuery).not.toHaveBeenCalled(); // 修正エージェントは呼ばれない
  });

  it('CIPollingTimeoutError の場合は timeout を返す', async () => {
    mockPollCIStatus.mockRejectedValueOnce(new CIPollingTimeoutError(900_000));

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    expect(result.finalStatus).toBe('timeout');
    expect(result.attempts).toBe(1);
  });

  it('CIPollingError の場合は failure を返す', async () => {
    mockPollCIStatus.mockRejectedValueOnce(
      new CIPollingError('gh: command not found'),
    );

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    expect(result.finalStatus).toBe('failure');
    expect(result.attempts).toBe(1);
  });

  it('予期しないエラーはそのまま throw される', async () => {
    mockPollCIStatus.mockRejectedValueOnce(new Error('unexpected'));

    await expect(
      runCIPollingLoop('/repo', 'feature/task-01', 'task desc'),
    ).rejects.toThrow('unexpected');
  });

  it('修正エージェントが失敗してもループは継続する', async () => {
    mockPollCIStatus
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(successResult());

    // 修正エージェントがエラーを投げる
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crash')),
      }),
    }));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    // エラーがあっても次の試行に進む
    expect(result.attempts).toBe(2);
    expect(result.attemptResults[0].fixDescription).toContain('CI fix agent failed');
    expect(result.finalStatus).toBe('success');

    consoleErrorSpy.mockRestore();
  });

  it('push が失敗してもループは継続する', async () => {
    mockPollCIStatus
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(successResult());

    // git push が失敗する
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('push rejected');
    });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    expect(result.finalStatus).toBe('success');
    expect(result.attemptResults[0].fixDescription).toContain('Push failed');

    consoleErrorSpy.mockRestore();
  });

  it('各試行にタイムスタンプが記録される', async () => {
    mockPollCIStatus
      .mockResolvedValueOnce(failureResult())
      .mockResolvedValueOnce(successResult());

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc');

    for (const attempt of result.attemptResults) {
      expect(attempt.timestamp).toBeInstanceOf(Date);
    }
  });

  it('CI失敗→失敗→成功で3回目に成功する', async () => {
    mockPollCIStatus
      .mockResolvedValueOnce(failureResult('fail 1'))
      .mockResolvedValueOnce(failureResult('fail 2'))
      .mockResolvedValueOnce(successResult());

    const result = await runCIPollingLoop('/repo', 'feature/task-01', 'task desc', {
      maxRetries: 3,
    });

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(3);
    expect(mockQuery).toHaveBeenCalledTimes(2); // 修正エージェント2回
  });
});

describe('buildCIFixPrompt', () => {
  it('CI失敗ログからCI修正プロンプトを生成する', () => {
    const prompt = buildCIFixPrompt(
      'Error: test failed at line 42',
      'タスクの説明',
      '/repo',
    );

    expect(prompt).toContain('タスクの説明');
    expect(prompt).toContain('/repo');
    expect(prompt).toContain('Error: test failed at line 42');
    expect(prompt).toContain('CI');
    expect(prompt).toContain('GitHub Actions');
  });
});

describe('pushFix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('git push が正しいブランチで呼ばれる', () => {
    mockExecSync.mockReturnValue('');

    pushFix('/repo', 'feature/task-01');

    expect(mockExecSync).toHaveBeenCalledWith(
      'git push origin feature/task-01',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});

describe('formatCIPollingResult', () => {
  it('成功結果をフォーマットする', () => {
    const result: CIPollingResult = {
      finalStatus: 'success',
      attempts: 1,
      attemptResults: [
        {
          attempt: 1,
          ciResult: successResult(),
          timestamp: new Date(),
        },
      ],
      lastCIResult: successResult(),
    };

    const text = formatCIPollingResult(result);

    expect(text).toContain('CI通過');
    expect(text).toContain('試行回数: 1');
  });

  it('失敗結果をフォーマットする', () => {
    const result: CIPollingResult = {
      finalStatus: 'failure',
      attempts: 1,
      attemptResults: [
        {
          attempt: 1,
          ciResult: failureResult(),
          timestamp: new Date(),
        },
      ],
      lastCIResult: failureResult(),
    };

    const text = formatCIPollingResult(result);

    expect(text).toContain('CI失敗');
  });

  it('タイムアウト結果をフォーマットする', () => {
    const result: CIPollingResult = {
      finalStatus: 'timeout',
      attempts: 1,
      attemptResults: [
        {
          attempt: 1,
          ciResult: { status: 'failure', summary: 'Polling timed out' },
          timestamp: new Date(),
        },
      ],
    };

    const text = formatCIPollingResult(result);

    expect(text).toContain('CIタイムアウト');
  });

  it('最大リトライ超過結果をフォーマットする', () => {
    const result: CIPollingResult = {
      finalStatus: 'max_retries_exceeded',
      attempts: 4,
      attemptResults: [
        { attempt: 1, ciResult: failureResult(), fixDescription: 'fix 1', timestamp: new Date() },
        { attempt: 2, ciResult: failureResult(), fixDescription: 'fix 2', timestamp: new Date() },
        { attempt: 3, ciResult: failureResult(), fixDescription: 'fix 3', timestamp: new Date() },
        { attempt: 4, ciResult: failureResult(), timestamp: new Date() },
      ],
      lastCIResult: failureResult(),
    };

    const text = formatCIPollingResult(result);

    expect(text).toContain('最大リトライ到達');
    expect(text).toContain('試行回数: 4');
    expect(text).toContain('修正履歴');
    expect(text).toContain('試行 1');
    expect(text).toContain('試行 2');
    expect(text).toContain('試行 3');
  });

  it('CI未設定結果をフォーマットする', () => {
    const result: CIPollingResult = {
      finalStatus: 'no_ci',
      attempts: 0,
      attemptResults: [],
    };

    const text = formatCIPollingResult(result);

    expect(text).toContain('CI未設定');
  });

  it('CI の URL が含まれる', () => {
    const result: CIPollingResult = {
      finalStatus: 'success',
      attempts: 1,
      attemptResults: [
        { attempt: 1, ciResult: successResult(), timestamp: new Date() },
      ],
      lastCIResult: successResult(),
    };

    const text = formatCIPollingResult(result);

    expect(text).toContain('https://github.com/test/repo/actions/runs/1');
  });
});
