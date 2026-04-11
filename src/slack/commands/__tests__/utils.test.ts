import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../config', () => ({
  config: {
    watchProjects: ['project-a', 'project-b'],
  },
}));

import { extractProjectOption, resolveProject, InvalidProjectError } from '../utils';

describe('extractProjectOption', () => {
  it('--project=xxx を抽出して残りの引数を返す', () => {
    const result = extractProjectOption(['--project=hoge', 'テスト', '概要']);
    expect(result.project).toBe('hoge');
    expect(result.remainingArgs).toEqual(['テスト', '概要']);
  });

  it('--project がない場合は undefined を返す', () => {
    const result = extractProjectOption(['テスト', '概要']);
    expect(result.project).toBeUndefined();
    expect(result.remainingArgs).toEqual(['テスト', '概要']);
  });

  it('引数の途中に --project がある場合も抽出する', () => {
    const result = extractProjectOption(['テスト', '--project=foo', '概要']);
    expect(result.project).toBe('foo');
    expect(result.remainingArgs).toEqual(['テスト', '概要']);
  });

  it('空の引数リストを処理する', () => {
    const result = extractProjectOption([]);
    expect(result.project).toBeUndefined();
    expect(result.remainingArgs).toEqual([]);
  });
});

describe('resolveProject', () => {
  it('undefined の場合は watchProjects[0] を返す', () => {
    expect(resolveProject(undefined)).toBe('project-a');
  });

  it('watchProjects に含まれるプロジェクト名はそのまま返す', () => {
    expect(resolveProject('project-b')).toBe('project-b');
  });

  it('watchProjects に含まれないプロジェクト名はエラーを投げる', () => {
    expect(() => resolveProject('unknown')).toThrow(InvalidProjectError);
    expect(() => resolveProject('unknown')).toThrow('登録されていません');
  });

  it('パストラバーサルを含むプロジェクト名はエラーを投げる', () => {
    expect(() => resolveProject('../../malicious')).toThrow(InvalidProjectError);
    expect(() => resolveProject('../../malicious')).toThrow('不正なプロジェクト名です');
  });

  it('ドットを含むプロジェクト名はエラーを投げる', () => {
    expect(() => resolveProject('a.b')).toThrow(InvalidProjectError);
  });

  it('スラッシュを含むプロジェクト名はエラーを投げる', () => {
    expect(() => resolveProject('a/b')).toThrow(InvalidProjectError);
  });

  it('空文字列はエラーを投げる', () => {
    expect(() => resolveProject('')).toThrow(InvalidProjectError);
  });

  it('英数字・ハイフン・アンダースコアのプロジェクト名は形式バリデーションを通過する', () => {
    // watchProjects に含まれないのでエラーにはなるが、形式バリデーションは通過する
    expect(() => resolveProject('valid-name_123')).toThrow('登録されていません');
  });
});

describe('resolveProject with empty watchProjects', () => {
  it('watchProjects が空の場合はエラーを投げる', async () => {
    // 動的に config をモック上書き
    const { config } = await import('../../../config');
    const original = [...config.watchProjects];
    config.watchProjects.length = 0;

    try {
      expect(() => resolveProject(undefined)).toThrow(InvalidProjectError);
      expect(() => resolveProject(undefined)).toThrow('watchProjects が設定されていません');
    } finally {
      config.watchProjects.push(...original);
    }
  });
});
