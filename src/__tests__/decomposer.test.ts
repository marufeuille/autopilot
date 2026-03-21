import { describe, it, expect } from 'vitest';
import { validateTaskDrafts } from '../decomposer';

const STORY_SLUG = 'my-story';

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    slug: `${STORY_SLUG}-01-setup`,
    title: 'セットアップ',
    priority: 'high',
    effort: 'low',
    purpose: '初期環境を整える',
    detail: '手順の詳細',
    criteria: ['条件1', '条件2'],
    ...overrides,
  };
}

describe('validateTaskDrafts', () => {
  // --- 正常系 ---

  it('有効なタスク配列を返す', () => {
    const input = [validDraft()];
    const result = validateTaskDrafts(input, STORY_SLUG);
    expect(result).toEqual(input);
  });

  it('複数タスクを含む有効な配列を返す', () => {
    const input = [
      validDraft(),
      validDraft({ slug: `${STORY_SLUG}-02-impl`, title: '実装' }),
    ];
    const result = validateTaskDrafts(input, STORY_SLUG);
    expect(result).toHaveLength(2);
  });

  it('priority / effort の全値を受け付ける', () => {
    for (const priority of ['high', 'medium', 'low'] as const) {
      for (const effort of ['low', 'medium', 'high'] as const) {
        expect(() =>
          validateTaskDrafts([validDraft({ priority, effort })], STORY_SLUG),
        ).not.toThrow();
      }
    }
  });

  // --- 配列レベルの異常系 ---

  it('配列でない場合にエラーをスローする', () => {
    expect(() => validateTaskDrafts('not array', STORY_SLUG)).toThrow(
      '配列ではありません',
    );
  });

  it('空配列の場合にエラーをスローする', () => {
    expect(() => validateTaskDrafts([], STORY_SLUG)).toThrow(
      '1つ以上のタスクが必要です',
    );
  });

  it('要素がオブジェクトでない場合にエラーをスローする', () => {
    expect(() => validateTaskDrafts(['string'], STORY_SLUG)).toThrow(
      'オブジェクトではありません',
    );
  });

  it('要素が null の場合にエラーをスローする', () => {
    expect(() => validateTaskDrafts([null], STORY_SLUG)).toThrow(
      'オブジェクトではありません',
    );
  });

  // --- 必須フィールド欠損 ---

  it.each([
    'slug',
    'title',
    'priority',
    'effort',
    'purpose',
    'detail',
    'criteria',
  ] as const)('必須フィールド "%s" が欠けている場合にエラーをスローする', (field) => {
    const draft = validDraft();
    delete (draft as Record<string, unknown>)[field];
    expect(() => validateTaskDrafts([draft], STORY_SLUG)).toThrow(
      `必須フィールド "${field}" がありません`,
    );
  });

  // --- slug の検証 ---

  it('slug が文字列でない場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts([validDraft({ slug: 123 })], STORY_SLUG),
    ).toThrow('slug: 文字列ではありません');
  });

  it('slug が kebab-case でない場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts(
        [validDraft({ slug: `${STORY_SLUG}-01_SETUP` })],
        STORY_SLUG,
      ),
    ).toThrow('kebab-case ではありません');
  });

  it('slug がストーリースラッグで始まらない場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts(
        [validDraft({ slug: 'other-story-01-setup' })],
        STORY_SLUG,
      ),
    ).toThrow(`"${STORY_SLUG}-" で始まっていません`);
  });

  // --- priority / effort の値域 ---

  it('priority が不正値の場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts([validDraft({ priority: 'critical' })], STORY_SLUG),
    ).toThrow('priority: "high" | "medium" | "low"');
  });

  it('priority が文字列でない場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts([validDraft({ priority: 1 })], STORY_SLUG),
    ).toThrow('priority: "high" | "medium" | "low"');
  });

  it('effort が不正値の場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts([validDraft({ effort: 'extreme' })], STORY_SLUG),
    ).toThrow('effort: "low" | "medium" | "high"');
  });

  // --- 文字列フィールドの型チェック ---

  it.each(['title', 'purpose', 'detail'] as const)(
    '%s が文字列でない場合にエラーをスローする',
    (field) => {
      expect(() =>
        validateTaskDrafts([validDraft({ [field]: 42 })], STORY_SLUG),
      ).toThrow(`${field}: 文字列ではありません`);
    },
  );

  // --- criteria の検証 ---

  it('criteria が配列でない場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts([validDraft({ criteria: 'not array' })], STORY_SLUG),
    ).toThrow('criteria: 配列ではありません');
  });

  it('criteria に文字列でない要素がある場合にエラーをスローする', () => {
    expect(() =>
      validateTaskDrafts(
        [validDraft({ criteria: ['ok', 123] })],
        STORY_SLUG,
      ),
    ).toThrow('すべての要素が文字列である必要があります');
  });

  // --- 複数エラーの同時報告 ---

  it('複数のエラーをまとめて報告する', () => {
    const draft = { slug: 123, title: 456 }; // 多数のフィールド欠損 + 型エラー
    try {
      validateTaskDrafts([draft], STORY_SLUG);
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('バリデーションエラー');
      // 複数の問題が報告されている
      const bulletCount = (msg.match(/  - /g) ?? []).length;
      expect(bulletCount).toBeGreaterThan(1);
    }
  });
});
