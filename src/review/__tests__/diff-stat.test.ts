import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { getDiffStat, truncateDiffStat, DIFF_STAT_MAX_LINES, DIFF_STAT_MAX_CHARS } from '../loop';
import * as child_process from 'child_process';

const mockedExecSync = vi.mocked(child_process.execSync);

describe('getDiffStat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('git diff --stat main...branch の出力を返す', () => {
    const stat = ' src/foo.ts | 10 +\n 1 file changed, 10 insertions(+)\n';
    mockedExecSync.mockReturnValue(stat);

    const result = getDiffStat('/repo', 'feature/test');

    expect(mockedExecSync).toHaveBeenCalledWith('git diff --stat main...feature/test', expect.objectContaining({
      cwd: '/repo',
      encoding: 'utf-8',
    }));
    expect(result).toBe(stat.trim());
  });

  it('main...branch が失敗した場合は HEAD にフォールバックする', () => {
    const stat = ' src/bar.ts | 5 +\n 1 file changed, 5 insertions(+)\n';
    mockedExecSync
      .mockImplementationOnce(() => { throw new Error('not a git repository'); })
      .mockReturnValueOnce(stat);

    const result = getDiffStat('/repo', 'feature/test');

    expect(mockedExecSync).toHaveBeenCalledTimes(2);
    expect(mockedExecSync).toHaveBeenNthCalledWith(2, 'git diff --stat HEAD', expect.objectContaining({
      cwd: '/repo',
    }));
    expect(result).toBe(stat.trim());
  });

  it('両方の git コマンドが失敗した場合は undefined を返す', () => {
    mockedExecSync
      .mockImplementationOnce(() => { throw new Error('fail1'); })
      .mockImplementationOnce(() => { throw new Error('fail2'); });

    const result = getDiffStat('/repo', 'feature/test');

    expect(result).toBeUndefined();
  });

  it('diff stat が空文字列の場合は undefined を返す', () => {
    mockedExecSync.mockReturnValue('   \n');

    const result = getDiffStat('/repo', 'feature/test');

    expect(result).toBeUndefined();
  });

  it('上限を超える diff stat はサマリ行のみに切り詰められる', () => {
    const fileLines = Array.from({ length: 60 }, (_, i) =>
      ` src/file${i}.ts | ${i + 1} +`
    );
    const summaryLine = ' 60 files changed, 1830 insertions(+)';
    const raw = [...fileLines, summaryLine, ''].join('\n');
    mockedExecSync.mockReturnValue(raw);

    const result = getDiffStat('/repo', 'feature/test');

    expect(result).toBe(summaryLine.trim());
  });
});

describe('truncateDiffStat', () => {
  it('上限以内の場合はそのまま返す（trim される）', () => {
    const stat = ' src/foo.ts | 10 +\n 1 file changed, 10 insertions(+)\n';
    expect(truncateDiffStat(stat)).toBe(stat.trim());
  });

  it('行数が上限を超えた場合はサマリ行のみ返す', () => {
    const fileLines = Array.from({ length: DIFF_STAT_MAX_LINES + 5 }, (_, i) =>
      ` src/file${i}.ts | 1 +`
    );
    const summaryLine = ` ${DIFF_STAT_MAX_LINES + 5} files changed, ${DIFF_STAT_MAX_LINES + 5} insertions(+)`;
    const raw = [...fileLines, summaryLine].join('\n');

    expect(truncateDiffStat(raw)).toBe(summaryLine.trim());
  });

  it('文字数が上限を超えた場合はサマリ行のみ返す', () => {
    // 長いファイル名で文字数上限を超えるケース
    const longName = 'a'.repeat(200);
    const fileLines = Array.from({ length: 15 }, (_, i) =>
      ` src/${longName}${i}.ts | 1 +`
    );
    const summaryLine = ' 15 files changed, 15 insertions(+)';
    const raw = [...fileLines, summaryLine].join('\n');

    // 文字数が上限を超えていることを確認
    expect(raw.length).toBeGreaterThan(DIFF_STAT_MAX_CHARS);

    expect(truncateDiffStat(raw)).toBe(summaryLine.trim());
  });

  it('行数・文字数ともに上限以内の場合はそのまま返す', () => {
    const fileLines = Array.from({ length: 3 }, (_, i) =>
      ` src/file${i}.ts | 5 +`
    );
    const summaryLine = ' 3 files changed, 15 insertions(+)';
    const raw = [...fileLines, summaryLine, ''].join('\n');

    expect(truncateDiffStat(raw)).toBe(raw.trim());
  });

  it('空行を含む出力でも正しく処理する', () => {
    const raw = ' src/a.ts | 1 +\n\n src/b.ts | 2 +\n\n 2 files changed, 3 insertions(+)\n\n';
    expect(truncateDiffStat(raw)).toBe(raw.trim());
  });
});

describe('定数', () => {
  it('DIFF_STAT_MAX_LINES が定義されている', () => {
    expect(DIFF_STAT_MAX_LINES).toBe(50);
  });

  it('DIFF_STAT_MAX_CHARS が定義されている', () => {
    expect(DIFF_STAT_MAX_CHARS).toBe(2000);
  });
});
