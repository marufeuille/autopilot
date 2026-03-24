import { describe, it, expect, vi } from 'vitest';
import {
  fetchPullRequestStatus,
  MergeServiceDeps,
} from '../merge-service';
import { MergeError } from '../types';

function createMockDeps(overrides?: Partial<MergeServiceDeps>): MergeServiceDeps {
  return {
    execGh: vi.fn().mockReturnValue(''),
    ...overrides,
  };
}

describe('fetchPullRequestStatus', () => {
  it('PRステータスを正しくパースする', () => {
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [
          { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      })),
    });

    const status = fetchPullRequestStatus('https://github.com/org/repo/pull/1', '/repo', deps);

    expect(status.state).toBe('OPEN');
    expect(status.mergeable).toBe('MERGEABLE');
    expect(status.reviewDecision).toBe('APPROVED');
    expect(status.statusCheckRollup).toHaveLength(1);
    expect(status.statusCheckRollup[0].name).toBe('CI');
    expect(status.statusCheckRollup[0].conclusion).toBe('SUCCESS');
  });

  it('gh pr view が失敗した場合に MergeError をスローする', () => {
    const deps = createMockDeps({
      execGh: vi.fn().mockImplementation(() => {
        throw new Error('not found');
      }),
    });

    expect(() =>
      fetchPullRequestStatus('https://github.com/org/repo/pull/999', '/repo', deps),
    ).toThrow(MergeError);

    try {
      fetchPullRequestStatus('https://github.com/org/repo/pull/999', '/repo', deps);
    } catch (e) {
      const err = e as MergeError;
      expect(err.code).toBe('unknown');
      expect(err.statusCode).toBe(500);
      expect(err.reason).toContain('PRステータスの取得に失敗しました');
    }
  });

  it('フィールドが欠損している場合もデフォルト値で返す', () => {
    const deps = createMockDeps({
      execGh: vi.fn().mockReturnValue(JSON.stringify({})),
    });

    const status = fetchPullRequestStatus('https://github.com/org/repo/pull/1', '/repo', deps);

    expect(status.state).toBe('UNKNOWN');
    expect(status.mergeable).toBe('UNKNOWN');
    expect(status.reviewDecision).toBe('');
    expect(status.statusCheckRollup).toHaveLength(0);
  });
});
