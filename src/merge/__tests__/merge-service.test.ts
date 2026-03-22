import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchPullRequestStatus,
  validateMergeConditions,
  classifyMergeError,
  executeMerge,
  formatMergeErrorMessage,
  MergeServiceDeps,
} from '../merge-service';
import { MergeError, PullRequestStatus } from '../types';

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

describe('validateMergeConditions', () => {
  const baseStatus: PullRequestStatus = {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  };

  it('すべて条件を満たす場合は mergeable: true', () => {
    const result = validateMergeConditions(baseStatus);
    expect(result.mergeable).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('PRがオープンでない場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      state: 'CLOSED',
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('pr_not_open');
    expect(result.errors[0].message).toContain('オープン状態ではありません');
  });

  it('CIが実行中の場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      statusCheckRollup: [
        { name: 'build', status: 'IN_PROGRESS', conclusion: '' },
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors[0].code).toBe('ci_not_passed');
    expect(result.errors[0].message).toContain('CIが未完了です');
    expect(result.errors[0].message).toContain('build');
  });

  it('CIがキューに入っている場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      statusCheckRollup: [
        { name: 'test', status: 'QUEUED', conclusion: '' },
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors[0].code).toBe('ci_not_passed');
    expect(result.errors[0].message).toContain('CIが未完了です');
  });

  it('CIがPENDINGの場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      statusCheckRollup: [
        { name: 'lint', status: 'PENDING', conclusion: '' },
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors[0].code).toBe('ci_not_passed');
    expect(result.errors[0].message).toContain('CIが未完了です');
  });

  it('CIが失敗している場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      statusCheckRollup: [
        { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors[0].code).toBe('ci_not_passed');
    expect(result.errors[0].message).toContain('CIが失敗しています');
    expect(result.errors[0].message).toContain('test');
  });

  it('CI結果がNEUTRALまたはSKIPPEDの場合はエラーにならない', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      statusCheckRollup: [
        { name: 'optional-check', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { name: 'skipped-check', status: 'COMPLETED', conclusion: 'SKIPPED' },
      ],
    });
    expect(result.mergeable).toBe(true);
  });

  it('承認数不足の場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      reviewDecision: 'REVIEW_REQUIRED',
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors[0].code).toBe('insufficient_approvals');
    expect(result.errors[0].message).toContain('承認数が不足しています');
  });

  it('変更リクエスト中の場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      reviewDecision: 'CHANGES_REQUESTED',
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors[0].code).toBe('insufficient_approvals');
    expect(result.errors[0].message).toContain('変更がリクエストされています');
  });

  it('マージコンフリクトがある場合にエラーを返す', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      mergeable: 'CONFLICTING',
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors[0].code).toBe('merge_conflict');
    expect(result.errors[0].message).toContain('マージコンフリクト');
  });

  it('複数の条件未充足がある場合にすべてのエラーを返す', () => {
    const result = validateMergeConditions({
      state: 'OPEN',
      mergeable: 'CONFLICTING',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [
        { name: 'test', status: 'IN_PROGRESS', conclusion: '' },
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);

    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('ci_not_passed');
    expect(codes).toContain('insufficient_approvals');
    expect(codes).toContain('merge_conflict');
  });

  it('statusCheckRollup が空の場合はCIエラーにならない', () => {
    const result = validateMergeConditions({
      ...baseStatus,
      statusCheckRollup: [],
    });
    expect(result.mergeable).toBe(true);
  });
});

describe('classifyMergeError', () => {
  it('権限不足エラーを正しく分類する (permission)', () => {
    const error = classifyMergeError('Resource not accessible by integration: permission denied');
    expect(error.code).toBe('permission_denied');
    expect(error.statusCode).toBe(403);
  });

  it('権限不足エラーを正しく分類する (403)', () => {
    const error = classifyMergeError('GraphQL: 403 Forbidden');
    expect(error.code).toBe('permission_denied');
    expect(error.statusCode).toBe(403);
  });

  it('権限不足エラーを正しく分類する (not allowed)', () => {
    const error = classifyMergeError('Merging is not allowed');
    expect(error.code).toBe('permission_denied');
    expect(error.statusCode).toBe(403);
  });

  it('ブランチ保護ルール違反を正しく分類する', () => {
    const error = classifyMergeError('Protected branch rules not met');
    expect(error.code).toBe('branch_protected');
    expect(error.statusCode).toBe(422);
  });

  it('ブランチ保護のrequired status checkを正しく分類する', () => {
    const error = classifyMergeError('Required status check "CI" has not passed');
    expect(error.code).toBe('branch_protected');
    expect(error.statusCode).toBe(422);
  });

  it('マージコンフリクトを正しく分類する', () => {
    const error = classifyMergeError('Pull request has merge conflicts');
    expect(error.code).toBe('merge_conflict');
    expect(error.statusCode).toBe(409);
  });

  it('CIエラーを正しく分類する', () => {
    const error = classifyMergeError('Some checks have not passed yet');
    expect(error.code).toBe('ci_not_passed');
    expect(error.statusCode).toBe(422);
  });

  it('PRが閉じている場合を正しく分類する', () => {
    const error = classifyMergeError('Pull request already merged');
    expect(error.code).toBe('pr_not_open');
    expect(error.statusCode).toBe(422);
  });

  it('承認不足を正しく分類する', () => {
    const error = classifyMergeError('At least 1 approving review is required');
    expect(error.code).toBe('insufficient_approvals');
    expect(error.statusCode).toBe(422);
  });

  it('不明なエラーはunknownとして分類する', () => {
    const error = classifyMergeError('Something completely unexpected');
    expect(error.code).toBe('unknown');
    expect(error.statusCode).toBe(500);
  });
});

describe('executeMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('バリデーション通過後にマージが成功する', () => {
    const execGh = vi.fn()
      .mockReturnValueOnce(JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [
          { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }))
      .mockReturnValueOnce('Merged!');

    const deps = createMockDeps({ execGh });

    const result = executeMerge('https://github.com/org/repo/pull/1', '/repo', deps);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
    expect(result.output).toBe('Merged!');

    // pr view + pr merge の2回呼ばれること
    expect(execGh).toHaveBeenCalledTimes(2);
  });

  it('CI未完了時に422エラーで失敗する', () => {
    const execGh = vi.fn().mockReturnValueOnce(JSON.stringify({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [
        { name: 'build', status: 'IN_PROGRESS', conclusion: '' },
      ],
    }));

    const deps = createMockDeps({ execGh });

    try {
      executeMerge('https://github.com/org/repo/pull/1', '/repo', deps);
      expect.unreachable('Should have thrown');
    } catch (e) {
      const err = e as MergeError;
      expect(err).toBeInstanceOf(MergeError);
      expect(err.code).toBe('ci_not_passed');
      expect(err.statusCode).toBe(422);
      expect(err.reason).toContain('CIが未完了です');
    }

    // pr merge は呼ばれないこと（pr view の1回のみ）
    expect(execGh).toHaveBeenCalledTimes(1);
  });

  it('承認数不足時に422エラーで失敗する', () => {
    const execGh = vi.fn().mockReturnValueOnce(JSON.stringify({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [],
    }));

    const deps = createMockDeps({ execGh });

    try {
      executeMerge('https://github.com/org/repo/pull/1', '/repo', deps);
      expect.unreachable('Should have thrown');
    } catch (e) {
      const err = e as MergeError;
      expect(err).toBeInstanceOf(MergeError);
      expect(err.code).toBe('insufficient_approvals');
      expect(err.statusCode).toBe(422);
      expect(err.reason).toContain('承認数が不足しています');
    }
  });

  it('権限不足時に403エラーで失敗する（gh pr merge 実行時エラー）', () => {
    const execGh = vi.fn()
      .mockReturnValueOnce(JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
      }))
      .mockImplementationOnce(() => {
        throw new Error('Resource not accessible: permission denied');
      });

    const deps = createMockDeps({ execGh });

    try {
      executeMerge('https://github.com/org/repo/pull/1', '/repo', deps);
      expect.unreachable('Should have thrown');
    } catch (e) {
      const err = e as MergeError;
      expect(err).toBeInstanceOf(MergeError);
      expect(err.code).toBe('permission_denied');
      expect(err.statusCode).toBe(403);
    }
  });

  it('マージコンフリクト時に409エラーで失敗する', () => {
    const execGh = vi.fn().mockReturnValueOnce(JSON.stringify({
      state: 'OPEN',
      mergeable: 'CONFLICTING',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [],
    }));

    const deps = createMockDeps({ execGh });

    try {
      executeMerge('https://github.com/org/repo/pull/1', '/repo', deps);
      expect.unreachable('Should have thrown');
    } catch (e) {
      const err = e as MergeError;
      expect(err).toBeInstanceOf(MergeError);
      expect(err.code).toBe('merge_conflict');
      expect(err.statusCode).toBe(409);
    }
  });

  it('skipValidation: true の場合はバリデーションをスキップしてマージを実行する', () => {
    const execGh = vi.fn().mockReturnValueOnce('Merged!');
    const deps = createMockDeps({ execGh });

    const result = executeMerge(
      'https://github.com/org/repo/pull/1',
      '/repo',
      deps,
      { skipValidation: true },
    );

    expect(result.success).toBe(true);
    // pr view は呼ばれず、pr merge のみ
    expect(execGh).toHaveBeenCalledTimes(1);
    expect(execGh).toHaveBeenCalledWith(
      ['pr', 'merge', 'https://github.com/org/repo/pull/1', '--squash', '--delete-branch'],
      '/repo',
    );
  });

  it('マージ成功時にステータスが merged に更新される（success: true）', () => {
    const execGh = vi.fn()
      .mockReturnValueOnce(JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
      }))
      .mockReturnValueOnce('');

    const deps = createMockDeps({ execGh });

    const result = executeMerge('https://github.com/org/repo/pull/1', '/repo', deps);

    expect(result.success).toBe(true);
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
  });

  it('gh pr merge のエラーが構造化された MergeError として返される', () => {
    const execGh = vi.fn()
      .mockReturnValueOnce(JSON.stringify({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [],
      }))
      .mockImplementationOnce(() => {
        throw new Error('Pull request has merge conflicts');
      });

    const deps = createMockDeps({ execGh });

    try {
      executeMerge('https://github.com/org/repo/pull/1', '/repo', deps);
      expect.unreachable('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MergeError);
      const err = e as MergeError;
      expect(err.code).toBe('merge_conflict');
      expect(err.statusCode).toBe(409);
    }
  });
});

describe('formatMergeErrorMessage', () => {
  it('CI未通過のアイコンとメッセージをフォーマットする', () => {
    const error = new MergeError('ci_not_passed', 'CIが未完了です', 422);
    const msg = formatMergeErrorMessage(error);
    expect(msg).toBe('🔴 CIが未完了です');
  });

  it('承認不足のアイコンとメッセージをフォーマットする', () => {
    const error = new MergeError('insufficient_approvals', '承認数が不足しています', 422);
    const msg = formatMergeErrorMessage(error);
    expect(msg).toBe('👥 承認数が不足しています');
  });

  it('権限不足のアイコンとメッセージをフォーマットする', () => {
    const error = new MergeError('permission_denied', 'マージ権限がありません', 403);
    const msg = formatMergeErrorMessage(error);
    expect(msg).toBe('🔒 マージ権限がありません');
  });

  it('マージコンフリクトのアイコンとメッセージをフォーマットする', () => {
    const error = new MergeError('merge_conflict', 'コンフリクトがあります', 409);
    const msg = formatMergeErrorMessage(error);
    expect(msg).toBe('⚠️ コンフリクトがあります');
  });

  it('ブランチ保護のアイコンとメッセージをフォーマットする', () => {
    const error = new MergeError('branch_protected', 'ブランチが保護されています', 422);
    const msg = formatMergeErrorMessage(error);
    expect(msg).toBe('🛡️ ブランチが保護されています');
  });

  it('不明なエラーのアイコンとメッセージをフォーマットする', () => {
    const error = new MergeError('unknown', 'マージに失敗しました', 500);
    const msg = formatMergeErrorMessage(error);
    expect(msg).toBe('❌ マージに失敗しました');
  });
});
