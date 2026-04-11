import { describe, it, expect } from 'vitest';
import { buildRetryContext } from '../context';
import type { ReviewLoopResult } from '../loop';
import type { ReviewFinding } from '../types';

function makeResult(overrides: Partial<ReviewLoopResult> = {}): ReviewLoopResult {
  return {
    finalVerdict: 'NG',
    escalationRequired: false,
    iterations: [],
    lastReviewResult: {
      verdict: 'NG',
      summary: 'テスト要約',
      findings: [],
    },
    warnings: [],
    ...overrides,
  };
}

describe('buildRetryContext', () => {
  it('ERROR 指摘のみ抽出し WARNING / INFO を含めない', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/a.ts', line: 10, severity: 'error', message: 'エラー1' },
      { file: 'src/b.ts', line: 20, severity: 'warning', message: '警告1' },
      { severity: 'info', message: '参考情報' },
      { file: 'src/c.ts', line: 30, severity: 'error', message: 'エラー2' },
    ];

    const result = buildRetryContext(
      makeResult({
        lastReviewResult: { verdict: 'NG', summary: '問題あり', findings },
      }),
    );

    expect(result.errorFindings).toHaveLength(2);
    expect(result.errorFindings!.every((f) => f.severity === 'error')).toBe(true);
    expect(result.errorFindings!.map((f) => f.message)).toEqual(['エラー1', 'エラー2']);
  });

  it('WARNING が RetryContext に一切含まれない', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/a.ts', line: 1, severity: 'warning', message: '警告のみ' },
      { severity: 'warning', message: '警告2' },
    ];

    const result = buildRetryContext(
      makeResult({
        lastReviewResult: { verdict: 'OK', summary: '警告のみ', findings },
      }),
    );

    // errorFindings は undefined（error がないため）
    expect(result.errorFindings).toBeUndefined();
    // RetryContext のどのフィールドにも warning 文字列が混入していないことを検証
    expect(JSON.stringify(result)).not.toContain('warning');
  });

  it('reviewSummary が正しく抽出される', () => {
    const result = buildRetryContext(
      makeResult({
        lastReviewResult: {
          verdict: 'NG',
          summary: 'テストカバレッジが不足しています',
          findings: [{ severity: 'error', message: 'テスト不足' }],
        },
      }),
    );

    expect(result.reviewSummary).toBe('テストカバレッジが不足しています');
  });

  it('reason が "セルフレビュー未通過" に設定される', () => {
    const result = buildRetryContext(makeResult());
    expect(result.reason).toBe('セルフレビュー未通過');
  });

  it('指摘なしの場合 errorFindings が undefined', () => {
    const result = buildRetryContext(
      makeResult({
        lastReviewResult: { verdict: 'OK', summary: '問題なし', findings: [] },
      }),
    );

    expect(result.errorFindings).toBeUndefined();
    expect(result.reviewSummary).toBe('問題なし');
    expect(result.reason).toBe('セルフレビュー未通過');
  });

  it('diffStat オプションが渡された場合に RetryContext に含まれる', () => {
    const diffStat = ' src/foo.ts | 10 +\n 1 file changed, 10 insertions(+)';
    const result = buildRetryContext(
      makeResult({
        lastReviewResult: { verdict: 'NG', summary: 'NG', findings: [{ severity: 'error', message: 'err' }] },
      }),
      { diffStat },
    );

    expect(result.diffStat).toBe(diffStat);
  });

  it('diffStat オプションが省略された場合は undefined', () => {
    const result = buildRetryContext(makeResult());
    expect(result.diffStat).toBeUndefined();
  });

  it('error 指摘のファイル・行番号情報が保持される', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/handler.ts', line: 42, severity: 'error', message: '未使用変数' },
    ];

    const result = buildRetryContext(
      makeResult({
        lastReviewResult: { verdict: 'NG', summary: 'NG', findings },
      }),
    );

    expect(result.errorFindings).toHaveLength(1);
    expect(result.errorFindings![0]).toEqual({
      file: 'src/handler.ts',
      line: 42,
      severity: 'error',
      message: '未使用変数',
    });
  });

  it('ファイル・行番号なしの error 指摘も正しく抽出される', () => {
    const findings: ReviewFinding[] = [
      { severity: 'error', message: '全般的なエラー' },
    ];

    const result = buildRetryContext(
      makeResult({
        lastReviewResult: { verdict: 'NG', summary: 'NG', findings },
      }),
    );

    expect(result.errorFindings).toHaveLength(1);
    expect(result.errorFindings![0].file).toBeUndefined();
    expect(result.errorFindings![0].line).toBeUndefined();
  });

  it('ReviewLoopResult が空のイテレーションでも動作する', () => {
    const result = buildRetryContext(
      makeResult({
        iterations: [],
        lastReviewResult: { verdict: 'NG', summary: '空イテレーション', findings: [] },
      }),
    );

    expect(result.reason).toBe('セルフレビュー未通過');
    expect(result.reviewSummary).toBe('空イテレーション');
    expect(result.errorFindings).toBeUndefined();
  });
});
