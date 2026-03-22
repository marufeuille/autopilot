import { describe, it, expect } from 'vitest';
import { ThreadSessionManager } from '../thread-session';

describe('ThreadSessionManager', () => {
  it('startSession で storySlug → threadTs を登録できる', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1234567890.123456');

    expect(manager.getThreadTs('story-a')).toBe('1234567890.123456');
  });

  it('未登録の storySlug に対して undefined を返す', () => {
    const manager = new ThreadSessionManager();

    expect(manager.getThreadTs('unknown-story')).toBeUndefined();
  });

  it('endSession でセッションを削除できる', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1234567890.123456');
    manager.endSession('story-a');

    expect(manager.getThreadTs('story-a')).toBeUndefined();
  });

  it('複数の story を同時に管理できる', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1111111111.111111');
    manager.startSession('story-b', '2222222222.222222');
    manager.startSession('story-c', '3333333333.333333');

    expect(manager.getThreadTs('story-a')).toBe('1111111111.111111');
    expect(manager.getThreadTs('story-b')).toBe('2222222222.222222');
    expect(manager.getThreadTs('story-c')).toBe('3333333333.333333');
  });

  it('同じ storySlug で二重 startSession しても既存セッションが維持される', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1111111111.111111');
    manager.startSession('story-a', '9999999999.999999');

    // 最初のセッションが維持され、上書きされない
    expect(manager.getThreadTs('story-a')).toBe('1111111111.111111');
  });

  it('存在しない storySlug の endSession はエラーにならない', () => {
    const manager = new ThreadSessionManager();

    expect(() => manager.endSession('nonexistent')).not.toThrow();
  });

  it('endSession は他のセッションに影響しない', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1111111111.111111');
    manager.startSession('story-b', '2222222222.222222');

    manager.endSession('story-a');

    expect(manager.getThreadTs('story-a')).toBeUndefined();
    expect(manager.getThreadTs('story-b')).toBe('2222222222.222222');
  });

  it('size でアクティブなセッション数を取得できる', () => {
    const manager = new ThreadSessionManager();
    expect(manager.size).toBe(0);

    manager.startSession('story-a', '1111111111.111111');
    expect(manager.size).toBe(1);

    manager.startSession('story-b', '2222222222.222222');
    expect(manager.size).toBe(2);

    manager.endSession('story-a');
    expect(manager.size).toBe(1);
  });

  it('二重 startSession でエラーにならずセッション数も増えない', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1111111111.111111');

    expect(() => manager.startSession('story-a', '9999999999.999999')).not.toThrow();
    expect(manager.size).toBe(1);
    expect(manager.getThreadTs('story-a')).toBe('1111111111.111111');
  });

  it('endSession 後に同じ storySlug で再度 startSession できる', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1111111111.111111');
    manager.endSession('story-a');

    // セッション終了後は新しいセッションを開始できる
    manager.startSession('story-a', '9999999999.999999');
    expect(manager.getThreadTs('story-a')).toBe('9999999999.999999');
  });

  it('複数セッションの個別解放が正しく動作する', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1111111111.111111');
    manager.startSession('story-b', '2222222222.222222');
    manager.startSession('story-c', '3333333333.333333');

    expect(manager.size).toBe(3);

    // story-b だけ解放
    manager.endSession('story-b');
    expect(manager.size).toBe(2);
    expect(manager.getThreadTs('story-a')).toBe('1111111111.111111');
    expect(manager.getThreadTs('story-b')).toBeUndefined();
    expect(manager.getThreadTs('story-c')).toBe('3333333333.333333');

    // story-a を解放
    manager.endSession('story-a');
    expect(manager.size).toBe(1);
    expect(manager.getThreadTs('story-c')).toBe('3333333333.333333');

    // story-c を解放
    manager.endSession('story-c');
    expect(manager.size).toBe(0);
  });
});
