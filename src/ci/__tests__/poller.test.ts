import { describe, it, expect, vi, beforeEach } from 'vitest';

// child_process をモック
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  getCIStatus,
  mapGitHubStatus,
  getFailureLogs,
  pollCIStatus,
  sleep,
} from '../poller';
import { CIPollingError, CIPollingTimeoutError } from '../types';

describe('mapGitHubStatus', () => {
  it('completed + success は success を返す', () => {
    expect(mapGitHubStatus('completed', 'success')).toBe('success');
  });

  it('completed + failure は failure を返す', () => {
    expect(mapGitHubStatus('completed', 'failure')).toBe('failure');
  });

  it('completed + cancelled は failure を返す', () => {
    expect(mapGitHubStatus('completed', 'cancelled')).toBe('failure');
  });

  it('completed + timed_out は failure を返す', () => {
    expect(mapGitHubStatus('completed', 'timed_out')).toBe('failure');
  });

  it('in_progress は pending を返す', () => {
    expect(mapGitHubStatus('in_progress', null)).toBe('pending');
  });

  it('queued は pending を返す', () => {
    expect(mapGitHubStatus('queued', null)).toBe('pending');
  });

  it('waiting は pending を返す', () => {
    expect(mapGitHubStatus('waiting', null)).toBe('pending');
  });
});

describe('getCIStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CI 実行が成功の場合に success を返す', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify([
        {
          databaseId: 123,
          status: 'completed',
          conclusion: 'success',
          name: 'CI',
          url: 'https://github.com/test/repo/actions/runs/123',
        },
      ]),
    );

    const result = getCIStatus('/repo', 'feature/task-01');

    expect(result.status).toBe('success');
    expect(result.summary).toContain('CI');
    expect(result.runUrl).toBe('https://github.com/test/repo/actions/runs/123');
    expect(result.failureLogs).toBeUndefined();
  });

  it('CI 実行が失敗の場合に failure を返しログを取得する', () => {
    mockExecSync
      .mockReturnValueOnce(
        JSON.stringify([
          {
            databaseId: 456,
            status: 'completed',
            conclusion: 'failure',
            name: 'CI',
            url: 'https://github.com/test/repo/actions/runs/456',
          },
        ]),
      )
      .mockReturnValueOnce('Error: test failed at line 42');

    const result = getCIStatus('/repo', 'feature/task-01');

    expect(result.status).toBe('failure');
    expect(result.failureLogs).toBe('Error: test failed at line 42');
  });

  it('CI 実行が進行中の場合に pending を返す（reason は no_runs_yet でない）', () => {
    mockExecSync.mockReturnValue(
      JSON.stringify([
        {
          databaseId: 789,
          status: 'in_progress',
          conclusion: null,
          name: 'CI',
          url: 'https://github.com/test/repo/actions/runs/789',
        },
      ]),
    );

    const result = getCIStatus('/repo', 'feature/task-01');

    expect(result.status).toBe('pending');
    expect(result.reason).toBeUndefined();
  });

  it('CI 実行がない場合は pending（reason: no_runs_yet）を返す', () => {
    mockExecSync.mockReturnValue('[]');

    const result = getCIStatus('/repo', 'feature/task-01');

    expect(result.status).toBe('pending');
    expect(result.reason).toBe('no_runs_yet');
    expect(result.summary).toContain('No CI runs found');
  });

  it('gh CLI が失敗した場合は CIPollingError を投げる', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('gh: command not found');
    });

    expect(() => getCIStatus('/repo', 'feature/task-01')).toThrow(CIPollingError);
  });

  it('gh run list に正しいブランチが渡される', () => {
    mockExecSync.mockReturnValue('[]');

    getCIStatus('/repo', 'feature/my-branch');

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--branch feature/my-branch'),
      expect.any(Object),
    );
  });
});

describe('getFailureLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('失敗ログを返す', () => {
    mockExecSync.mockReturnValue('Error log content');

    const logs = getFailureLogs('/repo', 123);

    expect(logs).toBe('Error log content');
    expect(mockExecSync).toHaveBeenCalledWith(
      'gh run view 123 --log-failed',
      expect.any(Object),
    );
  });

  it('長すぎるログは切り詰める', () => {
    const longLog = 'x'.repeat(20_000);
    mockExecSync.mockReturnValue(longLog);

    const logs = getFailureLogs('/repo', 123);

    expect(logs.length).toBeLessThan(longLog.length);
    expect(logs).toContain('...(truncated)');
  });

  it('ログ取得に失敗した場合はフォールバックメッセージを返す', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('network error');
    });

    const logs = getFailureLogs('/repo', 123);

    expect(logs).toBe('Failed to retrieve CI logs');
  });
});

describe('pollCIStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('最初の呼び出しで success の場合は即座に返る', async () => {
    mockExecSync.mockReturnValue(
      JSON.stringify([
        {
          databaseId: 1,
          status: 'completed',
          conclusion: 'success',
          name: 'CI',
          url: 'https://example.com',
        },
      ]),
    );

    const result = await pollCIStatus('/repo', 'feature/task-01', {
      pollingIntervalMs: 10,
      maxWaitMs: 1000,
    });

    expect(result.status).toBe('success');
  });

  it('最初の呼び出しで failure の場合は即座に返る', async () => {
    mockExecSync
      .mockReturnValueOnce(
        JSON.stringify([
          {
            databaseId: 1,
            status: 'completed',
            conclusion: 'failure',
            name: 'CI',
            url: 'https://example.com',
          },
        ]),
      )
      .mockReturnValueOnce('error logs'); // getFailureLogs

    const result = await pollCIStatus('/repo', 'feature/task-01', {
      pollingIntervalMs: 10,
      maxWaitMs: 1000,
    });

    expect(result.status).toBe('failure');
  });

  it('pending → success でポーリング後に返る', async () => {
    mockExecSync
      .mockReturnValueOnce(
        JSON.stringify([
          { databaseId: 1, status: 'in_progress', conclusion: null, name: 'CI' },
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([
          { databaseId: 1, status: 'completed', conclusion: 'success', name: 'CI' },
        ]),
      );

    const result = await pollCIStatus('/repo', 'feature/task-01', {
      pollingIntervalMs: 10,
      maxWaitMs: 5000,
    });

    expect(result.status).toBe('success');
  });

  it('タイムアウト時に CIPollingTimeoutError を投げる', async () => {
    // 常に pending を返す
    mockExecSync.mockReturnValue(
      JSON.stringify([
        { databaseId: 1, status: 'in_progress', conclusion: null, name: 'CI' },
      ]),
    );

    await expect(
      pollCIStatus('/repo', 'feature/task-01', {
        pollingIntervalMs: 10,
        maxWaitMs: 50,
      }),
    ).rejects.toThrow(CIPollingTimeoutError);
  });
});

describe('sleep', () => {
  it('指定したミリ秒待機する', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});
