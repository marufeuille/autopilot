/**
 * verdict判定〜修正ループの統合テスト
 *
 * determineVerdict → runReviewLoop → buildFixPrompt の一連のフローが
 * 受け入れ条件通りに動作することを検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewResult, ReviewFinding } from '../types';
import { determineVerdict } from '../types';

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
import { runReviewLoop, buildFixPrompt } from '../loop';
import { SubprocessReviewRunner } from '../subprocess-runner';

const mockedExecSync = vi.mocked(execSync);

function createMockRunner(results: ReviewResult[]) {
  let callCount = 0;
  return {
    review: vi.fn(async () => {
      const result = results[callCount];
      callCount++;
      if (!result) throw new Error('No more mock results');
      return result;
    }),
  } as unknown as SubprocessReviewRunner;
}

describe('verdict判定〜修正ループ 統合テスト', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockReturnValue('diff --git a/file.ts b/file.ts\n+some change');
  });

  // ---------------------------------------------------------------
  // シナリオ1: error+info混在 → NG判定かつ全指摘が修正プロンプトに含まれる
  // ---------------------------------------------------------------
  describe('error+info混在', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/api.ts', line: 42, severity: 'error', message: 'Null pointer dereference' },
      { severity: 'info', message: 'Consider adding JSDoc comments' },
    ];

    it('verdictがNGになる', () => {
      expect(determineVerdict(findings)).toBe('NG');
    });

    it('NG判定で修正ループが起動し、全指摘（error+info）が修正プロンプトに含まれる', async () => {
      const ngReview: ReviewResult = {
        verdict: 'NG',
        summary: 'Error and info findings',
        findings,
      };
      const okReview: ReviewResult = {
        verdict: 'OK',
        summary: 'All fixed',
        findings: [],
      };

      const runner = createMockRunner([ngReview, okReview]);

      const result = await runReviewLoop('/repo', 'feature/test', 'task desc', {
        reviewRunner: runner,
        maxRetries: 3,
      });

      // NG → 修正 → OK の2イテレーション
      expect(result.finalVerdict).toBe('OK');
      expect(result.iterations).toHaveLength(2);
      expect(result.iterations[0].reviewResult.verdict).toBe('NG');
      expect(result.iterations[0].fixDescription).toBeDefined();

      // 修正エージェントが呼ばれた（=修正ループが起動した）
      expect(mockQuery).toHaveBeenCalledTimes(1);

      // buildFixPrompt に error のみ含まれることを検証
      const fixPrompt = buildFixPrompt(ngReview, 'task desc', '/repo');
      expect(fixPrompt).toContain('[ERROR]');
      expect(fixPrompt).toContain('Null pointer dereference');
      // info は自動修正対象外
      expect(fixPrompt).not.toContain('Consider adding JSDoc comments');
    });
  });

  // ---------------------------------------------------------------
  // シナリオ2: warning+info混在 → OK判定かつ修正ループが起動しない
  // ---------------------------------------------------------------
  describe('warning+info混在', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/util.ts', line: 15, severity: 'warning', message: 'Unused variable detected' },
      { severity: 'info', message: 'Function could be simplified' },
    ];

    it('verdictがOKになる（warningは自動修正対象外）', () => {
      expect(determineVerdict(findings)).toBe('OK');
    });

    it('OK判定で修正ループが起動せず、warningsに格納される', async () => {
      const okReview: ReviewResult = {
        verdict: 'OK',
        summary: 'Warning and info findings only',
        findings,
      };

      const runner = createMockRunner([okReview]);

      const result = await runReviewLoop('/repo', 'feature/test', 'task desc', {
        reviewRunner: runner,
        maxRetries: 3,
      });

      // 1イテレーションで即OK
      expect(result.finalVerdict).toBe('OK');
      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0].fixDescription).toBeUndefined();

      // 修正エージェントは呼ばれない
      expect(mockQuery).not.toHaveBeenCalled();

      // warning は ReviewLoopResult.warnings に格納される
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toBe('Unused variable detected');
    });
  });

  // ---------------------------------------------------------------
  // シナリオ3: infoのみ → OK判定かつ修正ループが起動しない
  // ---------------------------------------------------------------
  describe('infoのみ', () => {
    const findings: ReviewFinding[] = [
      { severity: 'info', message: 'Minor style suggestion' },
      { severity: 'info', message: 'Consider using const instead of let' },
    ];

    it('verdictがOKになる', () => {
      expect(determineVerdict(findings)).toBe('OK');
    });

    it('OK判定で修正ループが起動しない', async () => {
      const okReview: ReviewResult = {
        verdict: 'OK',
        summary: 'Only info findings',
        findings,
      };

      const runner = createMockRunner([okReview]);

      const result = await runReviewLoop('/repo', 'feature/test', 'task desc', {
        reviewRunner: runner,
        maxRetries: 3,
      });

      // 1イテレーションで即OK
      expect(result.finalVerdict).toBe('OK');
      expect(result.escalationRequired).toBe(false);
      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0].reviewResult.verdict).toBe('OK');
      expect(result.iterations[0].fixDescription).toBeUndefined();

      // 修正エージェントが呼ばれていない
      expect(mockQuery).not.toHaveBeenCalled();

      // レビューは1回だけ実行された
      expect(runner.review).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------
  // シナリオ4: 指摘なし → OK判定かつ修正ループが起動しない
  // ---------------------------------------------------------------
  describe('指摘なし', () => {
    const findings: ReviewFinding[] = [];

    it('verdictがOKになる', () => {
      expect(determineVerdict(findings)).toBe('OK');
    });

    it('OK判定で修正ループが起動しない', async () => {
      const okReview: ReviewResult = {
        verdict: 'OK',
        summary: 'No issues found',
        findings,
      };

      const runner = createMockRunner([okReview]);

      const result = await runReviewLoop('/repo', 'feature/test', 'task desc', {
        reviewRunner: runner,
        maxRetries: 3,
      });

      // 1イテレーションで即OK
      expect(result.finalVerdict).toBe('OK');
      expect(result.escalationRequired).toBe(false);
      expect(result.iterations).toHaveLength(1);
      expect(result.iterations[0].reviewResult.verdict).toBe('OK');
      expect(result.iterations[0].fixDescription).toBeUndefined();

      // 修正エージェントが呼ばれていない
      expect(mockQuery).not.toHaveBeenCalled();

      // レビューは1回だけ実行された
      expect(runner.review).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------
  // 追加シナリオ: error+warning+info全混在 → NG判定かつ全指摘が修正プロンプトに含まれる
  // ---------------------------------------------------------------
  describe('error+warning+info全混在', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/main.ts', line: 10, severity: 'error', message: 'Critical bug' },
      { file: 'src/main.ts', line: 25, severity: 'warning', message: 'Potential issue' },
      { severity: 'info', message: 'Documentation suggestion' },
    ];

    it('verdictがNGになる', () => {
      expect(determineVerdict(findings)).toBe('NG');
    });

    it('修正プロンプトにはerrorのみ含まれ、warningとinfoは除外される', () => {
      const ngReview: ReviewResult = {
        verdict: 'NG',
        summary: 'All severity levels',
        findings,
      };

      const fixPrompt = buildFixPrompt(ngReview, 'task desc', '/repo');

      expect(fixPrompt).toContain('[ERROR] [src/main.ts:10] Critical bug');
      expect(fixPrompt).not.toContain('Potential issue');
      expect(fixPrompt).not.toContain('Documentation suggestion');
    });
  });
});
