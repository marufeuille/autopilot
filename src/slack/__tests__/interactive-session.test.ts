import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  InteractiveSessionManager,
  type InteractiveSession,
} from '../interactive-session';

function makeSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    threadTs: '1234567890.123456',
    channelId: 'C_TEST',
    type: 'story',
    phase: 'drafting',
    description: 'テスト用ストーリー',
    conversationHistory: [],
    ...overrides,
  };
}

describe('InteractiveSessionManager', () => {
  let manager: InteractiveSessionManager;

  beforeEach(() => {
    manager = new InteractiveSessionManager();
  });

  it('セッションを開始して取得できる', () => {
    const session = makeSession();
    manager.startSession(session);

    const retrieved = manager.getSession('1234567890.123456');
    expect(retrieved).toBeDefined();
    expect(retrieved!.threadTs).toBe('1234567890.123456');
    expect(retrieved!.phase).toBe('drafting');
    expect(retrieved!.type).toBe('story');
    expect(retrieved!.description).toBe('テスト用ストーリー');
  });

  it('存在しないスレッドIDの場合はundefinedを返す', () => {
    expect(manager.getSession('nonexistent')).toBeUndefined();
  });

  it('フェーズを更新できる', () => {
    manager.startSession(makeSession());
    manager.updatePhase('1234567890.123456', 'approved');

    const session = manager.getSession('1234567890.123456');
    expect(session!.phase).toBe('approved');
  });

  it('存在しないセッションのフェーズ更新は無視される', () => {
    // エラーにならないことを確認
    manager.updatePhase('nonexistent', 'approved');
    expect(manager.size).toBe(0);
  });

  it('会話履歴にメッセージを追加できる', () => {
    manager.startSession(makeSession());
    manager.addMessage('1234567890.123456', {
      role: 'user',
      content: 'タイトルを変更してください',
    });

    const session = manager.getSession('1234567890.123456');
    expect(session!.conversationHistory).toHaveLength(1);
    expect(session!.conversationHistory[0]).toEqual({
      role: 'user',
      content: 'タイトルを変更してください',
    });
  });

  it('存在しないセッションへのメッセージ追加は無視される', () => {
    manager.addMessage('nonexistent', { role: 'user', content: 'test' });
    expect(manager.size).toBe(0);
  });

  it('セッションを終了できる', () => {
    manager.startSession(makeSession());
    expect(manager.size).toBe(1);

    manager.endSession('1234567890.123456');
    expect(manager.size).toBe(0);
    expect(manager.getSession('1234567890.123456')).toBeUndefined();
  });

  it('存在しないセッションの終了は無視される', () => {
    manager.endSession('nonexistent');
    expect(manager.size).toBe(0);
  });

  it('複数セッションを同時管理できる', () => {
    manager.startSession(makeSession({ threadTs: 'ts-1', description: 'story A' }));
    manager.startSession(makeSession({ threadTs: 'ts-2', description: 'story B', type: 'fix' }));

    expect(manager.size).toBe(2);
    expect(manager.getSession('ts-1')!.description).toBe('story A');
    expect(manager.getSession('ts-2')!.description).toBe('story B');
    expect(manager.getSession('ts-2')!.type).toBe('fix');
  });

  it('sizeプロパティがアクティブなセッション数を返す', () => {
    expect(manager.size).toBe(0);
    manager.startSession(makeSession({ threadTs: 'ts-1' }));
    expect(manager.size).toBe(1);
    manager.startSession(makeSession({ threadTs: 'ts-2' }));
    expect(manager.size).toBe(2);
    manager.endSession('ts-1');
    expect(manager.size).toBe(1);
  });

  describe('listActiveSessions', () => {
    it('アクティブなセッション一覧を返す', () => {
      manager.startSession(makeSession({ threadTs: 'ts-1', type: 'story', phase: 'drafting' }));
      manager.startSession(makeSession({ threadTs: 'ts-2', type: 'fix', phase: 'executing' }));

      const sessions = manager.listActiveSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadTs: 'ts-1', type: 'story', phase: 'drafting' }),
          expect.objectContaining({ threadTs: 'ts-2', type: 'fix', phase: 'executing' }),
        ]),
      );
    });

    it('セッションがない場合は空配列を返す', () => {
      expect(manager.listActiveSessions()).toEqual([]);
    });

    it('会話履歴の件数が含まれる', () => {
      manager.startSession(makeSession({
        threadTs: 'ts-1',
        conversationHistory: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      }));

      const sessions = manager.listActiveSessions();
      expect(sessions[0].historyLength).toBe(2);
    });
  });

  describe('compareAndSwapPhase', () => {
    it('期待するフェーズと一致する場合、遷移してtrueを返す', () => {
      manager.startSession(makeSession({ phase: 'drafting' }));

      const result = manager.compareAndSwapPhase('1234567890.123456', 'drafting', 'approved');

      expect(result).toBe(true);
      expect(manager.getSession('1234567890.123456')!.phase).toBe('approved');
    });

    it('期待するフェーズと一致しない場合、falseを返す', () => {
      manager.startSession(makeSession({ phase: 'approved' }));

      const result = manager.compareAndSwapPhase('1234567890.123456', 'drafting', 'approved');

      expect(result).toBe(false);
      expect(manager.getSession('1234567890.123456')!.phase).toBe('approved');
    });

    it('セッションが存在しない場合、falseを返す', () => {
      const result = manager.compareAndSwapPhase('nonexistent', 'drafting', 'approved');

      expect(result).toBe(false);
    });

    it('二重承認を防止できる', () => {
      manager.startSession(makeSession({ phase: 'drafting' }));

      const first = manager.compareAndSwapPhase('1234567890.123456', 'drafting', 'approved');
      const second = manager.compareAndSwapPhase('1234567890.123456', 'drafting', 'approved');

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(manager.getSession('1234567890.123456')!.phase).toBe('approved');
    });
  });
});
