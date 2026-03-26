import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewResult } from '../types';

// child_process をモック
vi.mock('child_process', () => ({
  execSync: vi.fn(),
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

import { execSync } from 'child_process';
import {
  runReviewLoop,
  formatReviewLoopResult,
  getDiff,
  buildFixPrompt,
  ReviewLoopResult,
} from '../loop';
import { SubprocessReviewRunner } from '../subprocess-runner';
import { ReviewError } from '../types';

const mockedExecSync = vi.mocked(execSync);

function createMockRunner(results: ReviewResult[]) {
  let callCount = 0;
  const runner = {
    review: vi.fn(async () => {
      const result = results[callCount];
      callCount++;
      if (!result) throw new Error('No more mock results');
      return result;
    }),
  } as unknown as SubprocessReviewRunner;
  return runner;
}

function okResult(summary = 'All good'): ReviewResult {
  return { verdict: 'OK', summary, findings: [] };
}

function ngResult(summary = 'Issues found'): ReviewResult {
  return {
    verdict: 'NG',
    summary,
    findings: [
      { file: 'src/foo.ts', line: 10, severity: 'error', message: 'Bug found' },
      { severity: 'warning', message: 'Consider refactoring' },
    ],
  };
}

describe('runReviewLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getDiff のデフォルト: diff がある状態
    mockedExecSync.mockReturnValue('diff --git a/file.ts b/file.ts\n+some change');
  });

  it('最初のレビューでOKならイテレーション1回で終了する', async () => {
    const runner = createMockRunner([okResult()]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
    });

    expect(result.finalVerdict).toBe('OK');
    expect(result.escalationRequired).toBe(false);
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].iteration).toBe(1);
    expect(result.iterations[0].reviewResult.verdict).toBe('OK');
    expect(result.iterations[0].fixDescription).toBeUndefined();
    expect(runner.review).toHaveBeenCalledTimes(1);
  });

  it('NG→修正→OKでイテレーション2回で終了する', async () => {
    const runner = createMockRunner([ngResult(), okResult()]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      maxRetries: 3,
    });

    expect(result.finalVerdict).toBe('OK');
    expect(result.escalationRequired).toBe(false);
    expect(result.iterations).toHaveLength(2);
    // 1回目: NG + 修正あり
    expect(result.iterations[0].reviewResult.verdict).toBe('NG');
    expect(result.iterations[0].fixDescription).toBeDefined();
    // 2回目: OK
    expect(result.iterations[1].reviewResult.verdict).toBe('OK');
    expect(result.iterations[1].fixDescription).toBeUndefined();
    // 修正エージェントが1回呼ばれた
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('最大リトライ回数到達でエスカレーションされる', async () => {
    const runner = createMockRunner([
      ngResult('Issue 1'),
      ngResult('Issue 2'),
      ngResult('Issue 3'),
      ngResult('Issue 4'),
    ]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      maxRetries: 3,
    });

    expect(result.finalVerdict).toBe('NG');
    expect(result.escalationRequired).toBe(true);
    // 初回 + 3回リトライ = 4回
    expect(result.iterations).toHaveLength(4);
    // 修正エージェントは3回呼ばれた（最後のNGでは修正しない）
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('maxRetries=0 の場合、1回だけレビューして結果を返す', async () => {
    const runner = createMockRunner([ngResult()]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      maxRetries: 0,
    });

    expect(result.finalVerdict).toBe('NG');
    expect(result.escalationRequired).toBe(true);
    expect(result.iterations).toHaveLength(1);
    expect(mockQuery).not.toHaveBeenCalled(); // 修正エージェントは呼ばれない
  });

  it('diff が空の場合はOKで即終了する', async () => {
    mockedExecSync.mockReturnValue('');
    const runner = createMockRunner([]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
    });

    expect(result.finalVerdict).toBe('OK');
    expect(result.escalationRequired).toBe(false);
    expect(result.iterations).toHaveLength(1);
    expect(result.lastReviewResult.summary).toBe('No changes to review');
    expect(runner.review).not.toHaveBeenCalled();
  });

  it('ReviewError 発生時はエスカレーションで終了する', async () => {
    const runner = {
      review: vi.fn().mockRejectedValue(new ReviewError('Agent timed out')),
    } as unknown as SubprocessReviewRunner;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
    });

    expect(result.finalVerdict).toBe('NG');
    expect(result.escalationRequired).toBe(true);
    expect(result.iterations).toHaveLength(1);
    expect(result.lastReviewResult.summary).toContain('Agent timed out');

    consoleErrorSpy.mockRestore();
  });

  it('ReviewError 以外のエラーはそのまま throw される', async () => {
    const runner = {
      review: vi.fn().mockRejectedValue(new Error('unexpected')),
    } as unknown as SubprocessReviewRunner;

    await expect(
      runReviewLoop('/repo', 'feature/task-01', 'task desc', {
        reviewRunner: runner,
      }),
    ).rejects.toThrow('unexpected');
  });

  it('各イテレーションにタイムスタンプが記録される', async () => {
    const runner = createMockRunner([ngResult(), okResult()]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
    });

    for (const iter of result.iterations) {
      expect(iter.timestamp).toBeInstanceOf(Date);
    }
  });

  it('修正エージェントが失敗してもループは継続する', async () => {
    const runner = createMockRunner([ngResult(), okResult()]);

    // 修正エージェントがエラーを投げる
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crash')),
      }),
    }));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
    });

    // エラーがあっても次のイテレーションに進む
    expect(result.iterations).toHaveLength(2);
    expect(result.iterations[0].fixDescription).toContain('Fix agent failed');
    expect(result.finalVerdict).toBe('OK');

    consoleErrorSpy.mockRestore();
  });

  it('NG→NG→OKでイテレーション3回で終了する', async () => {
    const runner = createMockRunner([
      ngResult('Issue 1'),
      ngResult('Issue 2'),
      okResult('Fixed'),
    ]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      maxRetries: 3,
    });

    expect(result.finalVerdict).toBe('OK');
    expect(result.escalationRequired).toBe(false);
    expect(result.iterations).toHaveLength(3);
    expect(mockQuery).toHaveBeenCalledTimes(2); // 修正エージェント2回
  });
});

describe('getDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('main...branch の diff を返す', () => {
    mockedExecSync.mockReturnValue('diff content');

    const result = getDiff('/repo', 'feature/task-01');

    expect(result).toBe('diff content');
    expect(mockedExecSync).toHaveBeenCalledWith(
      'git diff main...feature/task-01',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('main...branch が失敗した場合は HEAD diff にフォールバック', () => {
    mockedExecSync
      .mockImplementationOnce(() => {
        throw new Error('branch not found');
      })
      .mockReturnValueOnce('head diff' as never);

    const result = getDiff('/repo', 'feature/task-01');

    expect(result).toBe('head diff');
  });

  it('両方失敗した場合は空文字を返す', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('git error');
    });

    const result = getDiff('/repo', 'feature/task-01');

    expect(result).toBe('');
  });
});

describe('buildFixPrompt', () => {
  it('レビュー結果から修正プロンプトを生成する', () => {
    const review = ngResult();
    const prompt = buildFixPrompt(review, 'タスクの説明', '/repo');

    expect(prompt).toContain('タスクの説明');
    expect(prompt).toContain('/repo');
    expect(prompt).toContain('Bug found');
    expect(prompt).toContain('Consider refactoring');
    expect(prompt).toContain('[ERROR]');
    expect(prompt).toContain('[WARNING]');
    expect(prompt).toContain('src/foo.ts:10');
  });

  it('info レベルの指摘もプロンプトに含まれる', () => {
    const review: ReviewResult = {
      verdict: 'NG',
      summary: 'Issues',
      findings: [
        { severity: 'info', message: 'Just FYI' },
        { severity: 'error', message: 'Must fix' },
      ],
    };
    const prompt = buildFixPrompt(review, 'task', '/repo');

    expect(prompt).toContain('Just FYI');
    expect(prompt).toContain('[INFO]');
    expect(prompt).toContain('Must fix');
    expect(prompt).toContain('[ERROR]');
  });

  it('全severity（error・warning・info）の指摘がプロンプトに含まれる', () => {
    const review: ReviewResult = {
      verdict: 'NG',
      summary: 'Multiple issues',
      findings: [
        { file: 'src/a.ts', line: 1, severity: 'error', message: 'Critical bug' },
        { file: 'src/b.ts', line: 20, severity: 'warning', message: 'Potential issue' },
        { severity: 'info', message: 'Style suggestion' },
      ],
    };
    const prompt = buildFixPrompt(review, 'task', '/repo');

    expect(prompt).toContain('[ERROR] [src/a.ts:1] Critical bug');
    expect(prompt).toContain('[WARNING] [src/b.ts:20] Potential issue');
    expect(prompt).toContain('[INFO] Style suggestion');
  });

  it('各指摘のseverityラベルがプロンプト内で識別可能', () => {
    const review: ReviewResult = {
      verdict: 'NG',
      summary: 'Issues',
      findings: [
        { severity: 'error', message: 'Error msg' },
        { severity: 'warning', message: 'Warning msg' },
        { severity: 'info', message: 'Info msg' },
      ],
    };
    const prompt = buildFixPrompt(review, 'task', '/repo');

    // severity ラベルが大文字で含まれていること
    expect(prompt).toMatch(/\[ERROR\].*Error msg/);
    expect(prompt).toMatch(/\[WARNING\].*Warning msg/);
    expect(prompt).toMatch(/\[INFO\].*Info msg/);
  });
});

describe('formatReviewLoopResult', () => {
  it('OK結果をフォーマットする', () => {
    const result: ReviewLoopResult = {
      finalVerdict: 'OK',
      escalationRequired: false,
      iterations: [
        { iteration: 1, reviewResult: okResult(), timestamp: new Date() },
      ],
      lastReviewResult: okResult(),
    };

    const text = formatReviewLoopResult(result);

    expect(text).toContain('セルフレビュー通過');
    expect(text).toContain('イテレーション数: 1');
    expect(text).toContain('OK');
  });

  it('エスカレーション結果をフォーマットする', () => {
    const result: ReviewLoopResult = {
      finalVerdict: 'NG',
      escalationRequired: true,
      iterations: [
        { iteration: 1, reviewResult: ngResult(), fixDescription: 'fix 1', timestamp: new Date() },
        { iteration: 2, reviewResult: ngResult(), fixDescription: 'fix 2', timestamp: new Date() },
        { iteration: 3, reviewResult: ngResult(), timestamp: new Date() },
      ],
      lastReviewResult: ngResult(),
    };

    const text = formatReviewLoopResult(result);

    expect(text).toContain('エスカレーション');
    expect(text).toContain('イテレーション数: 3');
    expect(text).toContain('Bug found');
    expect(text).toContain('src/foo.ts:10');
  });
});
