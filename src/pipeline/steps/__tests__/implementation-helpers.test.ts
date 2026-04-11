import { describe, it, expect, vi } from 'vitest';

// 外部パッケージの transitive import をモック
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}));

vi.mock('gray-matter', () => ({
  default: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: vi.fn(),
}));

import { truncateDiffStat, formatErrorFindings } from '../implementation';
import type { ReviewFinding } from '../../../review/types';

describe('truncateDiffStat', () => {
  it('上限以下��場合はそのまま返す', () => {
    const stat = ' src/foo.ts | 10 +\n 1 file changed';
    expect(truncateDiffStat(stat)).toBe(stat);
  });

  it('上限を超えた場合は切り詰めて省略メッセージを付与する', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ` src/file-${i}.ts | ${i} +`);
    const stat = lines.join('\n');
    const result = truncateDiffStat(stat, 100);
    expect(result.length).toBeLessThan(stat.length);
    expect(result).toContain('... (以降省略)');
  });

  it('行の途中で切れずに最後の完全な行まで切り詰め���', () => {
    const stat = 'line1\nline2\nline3\nline4';
    const result = truncateDiffStat(stat, 15);
    expect(result).toContain('line1\nline2');
    expect(result).toContain('... (以降省略)');
    expect(result).not.toContain('line3');
  });

  it('カスタム maxLength を指定できる', () => {
    const stat = 'a'.repeat(500);
    const result = truncateDiffStat(stat, 100);
    expect(result.length).toBeLessThan(500);
  });

  it('空文字列はそのまま返す', () => {
    expect(truncateDiffStat('')).toBe('');
  });
});

describe('formatErrorFindings', () => {
  it('ファイル名と行番号がある場合は "ファイル:行番号" 形式で表示する', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/handler.ts', line: 42, severity: 'error', message: '未使用変数' },
    ];
    const result = formatErrorFindings(findings);
    expect(result).toBe('- **src/handler.ts:42**: 未使用変数');
  });

  it('ファイル名のみ（行番号なし）の場合はファイル名のみ表示する', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/utils.ts', severity: 'error', message: 'エラーハンドリング不足' },
    ];
    const result = formatErrorFindings(findings);
    expect(result).toBe('- **src/utils.ts**: エラーハンドリング不足');
  });

  it('ファイル名も行番号もない場合は "(ファイル不明)" と表示する', () => {
    const findings: ReviewFinding[] = [
      { severity: 'error', message: '全般的なエラー' },
    ];
    const result = formatErrorFindings(findings);
    expect(result).toBe('- **(ファイル不明)**: 全般的なエラー');
  });

  it('複数の指摘を改行区切りでリスト形式にす��', () => {
    const findings: ReviewFinding[] = [
      { file: 'src/a.ts', line: 10, severity: 'error', message: 'エラー1' },
      { file: 'src/b.ts', severity: 'error', message: 'エラー2' },
      { severity: 'error', message: 'エラー3' },
    ];
    const result = formatErrorFindings(findings);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('- **src/a.ts:10**: エラー1');
    expect(lines[1]).toBe('- **src/b.ts**: エラー2');
    expect(lines[2]).toBe('- **(ファイル不明)**: エラー3');
  });

  it('空配列の場合は空文��列を返す', () => {
    expect(formatErrorFindings([])).toBe('');
  });
});
