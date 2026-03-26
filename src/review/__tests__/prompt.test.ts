import { describe, it, expect } from 'vitest';
import { buildReviewPrompt } from '../prompt';

describe('buildReviewPrompt', () => {
  it('should include diff in the prompt', () => {
    const prompt = buildReviewPrompt({ diff: '+ added line\n- removed line' });
    expect(prompt).toContain('+ added line\n- removed line');
  });

  it('should include review perspectives', () => {
    const prompt = buildReviewPrompt({ diff: 'test diff' });
    expect(prompt).toContain('正確性');
    expect(prompt).toContain('セキュリティ');
    expect(prompt).toContain('エラーハンドリング');
    expect(prompt).toContain('型安全性');
    expect(prompt).toContain('テスト');
    expect(prompt).toContain('コード品質');
  });

  it('should include JSON output schema', () => {
    const prompt = buildReviewPrompt({ diff: 'test diff' });
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
  });

  it('should specify that error or warning makes verdict NG', () => {
    const prompt = buildReviewPrompt({ diff: 'test diff' });
    expect(prompt).toContain('"error" または "warning"');
    expect(prompt).toContain('"info" のみの場合は "OK"');
  });

  it('should include task description when provided', () => {
    const prompt = buildReviewPrompt({
      diff: 'test diff',
      taskDescription: 'Implement login feature',
    });
    expect(prompt).toContain('タスクの説明');
    expect(prompt).toContain('Implement login feature');
  });

  it('should not include task section when no description', () => {
    const prompt = buildReviewPrompt({ diff: 'test diff' });
    expect(prompt).not.toContain('タスクの説明');
  });
});
