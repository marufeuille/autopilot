import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewResult } from '../types';
import type { AgentBackend } from '../../agent/backend';

// child_process をモック
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// agent/backend をモック（createBackend のフォールバックテスト用）
const mockDefaultBackend: AgentBackend & { run: ReturnType<typeof vi.fn> } = {
  run: vi.fn().mockResolvedValue('fix applied by default backend'),
};
vi.mock('../../agent/backend', () => ({
  createBackend: vi.fn(() => mockDefaultBackend),
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

/** モック AgentBackend を生成する */
function createMockFixBackend(): AgentBackend & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn().mockResolvedValue('fix applied'),
  };
}

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
  let mockFixBackend: ReturnType<typeof createMockFixBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    // getDiff のデフォルト: diff がある状態
    mockedExecSync.mockReturnValue('diff --git a/file.ts b/file.ts\n+some change');
    mockFixBackend = createMockFixBackend();
  });

  it('最初のレビューでOKならイテレーション1回で終了する', async () => {
    const runner = createMockRunner([okResult()]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      fixBackend: mockFixBackend,
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
      fixBackend: mockFixBackend,
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
    // 修正エージェント（fixBackend）が1回呼ばれた
    expect(mockFixBackend.run).toHaveBeenCalledTimes(1);
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
      fixBackend: mockFixBackend,
    });

    expect(result.finalVerdict).toBe('NG');
    expect(result.escalationRequired).toBe(true);
    // 初回 + 3回リトライ = 4回
    expect(result.iterations).toHaveLength(4);
    // 修正エージェントは3回呼ばれた（最後のNGでは修正しない）
    expect(mockFixBackend.run).toHaveBeenCalledTimes(3);
  });

  it('maxRetries=0 の場合、1回だけレビューして結果を返す', async () => {
    const runner = createMockRunner([ngResult()]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      maxRetries: 0,
      fixBackend: mockFixBackend,
    });

    expect(result.finalVerdict).toBe('NG');
    expect(result.escalationRequired).toBe(true);
    expect(result.iterations).toHaveLength(1);
    expect(mockFixBackend.run).not.toHaveBeenCalled(); // 修正エージェントは呼ばれない
  });

  it('diff が空の場合はOKで即終了する', async () => {
    mockedExecSync.mockReturnValue('');
    const runner = createMockRunner([]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      fixBackend: mockFixBackend,
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
      fixBackend: mockFixBackend,
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
        fixBackend: mockFixBackend,
      }),
    ).rejects.toThrow('unexpected');
  });

  it('各イテレーションにタイムスタンプが記録される', async () => {
    const runner = createMockRunner([ngResult(), okResult()]);

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      fixBackend: mockFixBackend,
    });

    for (const iter of result.iterations) {
      expect(iter.timestamp).toBeInstanceOf(Date);
    }
  });

  it('修正エージェントが失敗してもループは継続する', async () => {
    const runner = createMockRunner([ngResult(), okResult()]);

    // 修正エージェントがエラーを投げる
    mockFixBackend.run.mockRejectedValueOnce(new Error('agent crash'));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      fixBackend: mockFixBackend,
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
      fixBackend: mockFixBackend,
    });

    expect(result.finalVerdict).toBe('OK');
    expect(result.escalationRequired).toBe(false);
    expect(result.iterations).toHaveLength(3);
    expect(mockFixBackend.run).toHaveBeenCalledTimes(2); // 修正エージェント2回
  });

  it('fixBackend 未指定時は createBackend でフォールバックする', async () => {
    const runner = createMockRunner([ngResult(), okResult()]);
    mockDefaultBackend.run.mockClear();

    const { createBackend } = await import('../../agent/backend');
    const mockedCreateBackend = vi.mocked(createBackend);
    mockedCreateBackend.mockClear();

    const result = await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      // fixBackend を指定しない
    });

    expect(result.finalVerdict).toBe('OK');
    expect(result.iterations).toHaveLength(2);
    // createBackend がデフォルト設定で呼ばれた
    expect(mockedCreateBackend).toHaveBeenCalledWith({ type: 'claude' });
    // デフォルトバックエンドの run が呼ばれた
    expect(mockDefaultBackend.run).toHaveBeenCalledTimes(1);
  });

  it('fixBackend.run に正しい引数が渡される', async () => {
    const runner = createMockRunner([ngResult(), okResult()]);

    await runReviewLoop('/repo', 'feature/task-01', 'task desc', {
      reviewRunner: runner,
      fixBackend: mockFixBackend,
    });

    expect(mockFixBackend.run).toHaveBeenCalledWith(
      expect.stringContaining('Bug found'),
      expect.objectContaining({
        cwd: '/repo',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
      }),
    );
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
  it('レビュー結果から修正プロンプトを生成する（errorのみ、warningは除外）', () => {
    const review = ngResult();
    const prompt = buildFixPrompt(review, 'タスクの説明', '/repo');

    expect(prompt).toContain('タスクの説明');
    expect(prompt).toContain('/repo');
    expect(prompt).toContain('Bug found');
    expect(prompt).toContain('[ERROR]');
    expect(prompt).toContain('src/foo.ts:10');
    // warning は自動修正対象外なのでプロンプトに含まれない
    expect(prompt).not.toContain('Consider refactoring');
    expect(prompt).not.toContain('[WARNING]');
  });

  it('infoはプロンプトに含まれずerrorのみ含まれる', () => {
    const review: ReviewResult = {
      verdict: 'NG',
      summary: 'Issues',
      findings: [
        { severity: 'info', message: 'Just FYI' },
        { severity: 'error', message: 'Must fix' },
      ],
    };
    const prompt = buildFixPrompt(review, 'task', '/repo');

    expect(prompt).not.toContain('Just FYI');
    expect(prompt).toContain('Must fix');
    expect(prompt).toContain('[ERROR]');
  });

  it('error のみ修正プロンプトに含まれる（warning・infoは除外）', () => {
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
    expect(prompt).not.toContain('Potential issue');
    expect(prompt).not.toContain('Style suggestion');
  });

  it('errorのみseverityラベル付きでプロンプトに含まれる', () => {
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

    expect(prompt).toMatch(/\[ERROR\].*Error msg/);
    expect(prompt).not.toContain('Warning msg');
    expect(prompt).not.toContain('Info msg');
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
      warnings: [],
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
      warnings: [{ severity: 'warning', message: 'Consider refactoring' }],
    };

    const text = formatReviewLoopResult(result);

    expect(text).toContain('エスカレーション');
    expect(text).toContain('イテレーション数: 3');
    expect(text).toContain('Bug found');
    expect(text).toContain('src/foo.ts:10');
    // warning は別セクションで表示される
    expect(text).toContain('警告（要確認）');
    expect(text).toContain('Consider refactoring');
  });
});
