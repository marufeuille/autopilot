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

  it('同じ storySlug で再登録すると上書きされる', () => {
    const manager = new ThreadSessionManager();
    manager.startSession('story-a', '1111111111.111111');
    manager.startSession('story-a', '9999999999.999999');

    expect(manager.getThreadTs('story-a')).toBe('9999999999.999999');
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
});
