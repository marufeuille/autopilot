import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config', () => ({
  config: {
    watchProject: 'test-project',
    vaultPath: '/vault',
    slack: { channelId: 'C_TEST_CHANNEL' },
  },
  vaultStoriesPath: vi.fn(),
}));

import {
  handleApproveInternal,
  handleCancelInternal,
  getLatestDraft,
  type StoryApprovalDeps,
} from '../story-approval';
import {
  interactiveSessionManager,
  type InteractiveSession,
} from '../../interactive-session';

function makeSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    threadTs: '1234567890.123456',
    channelId: 'C_TEST_CHANNEL',
    type: 'story',
    phase: 'drafting',
    description: 'テスト用ストーリー',
    project: 'test-project',
    conversationHistory: [
      { role: 'user', content: 'テスト用ストーリー' },
      {
        role: 'assistant',
        content:
          '### タイトル\nTest Story\n\n### 価値・ゴール\nテスト価値\n\n### 受け入れ条件\n- [ ] 条件1\n\n### タスク案\n1. タスク1',
      },
    ],
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<StoryApprovalDeps> = {}): StoryApprovalDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '9999999999.999999' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    writeStoryToVault: vi.fn().mockReturnValue('/vault/Projects/test-project/stories/test-story.md'),
    ...overrides,
  };
}

describe('getLatestDraft', () => {
  beforeEach(() => {
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('セッションの最後のassistantメッセージを返す', () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: '要望' },
        { role: 'assistant', content: '初回ドラフト' },
        { role: 'user', content: '修正依頼' },
        { role: 'assistant', content: '最終ドラフト' },
      ],
    });
    interactiveSessionManager.startSession(session);

    const draft = getLatestDraft('1234567890.123456');
    expect(draft).toBe('最終ドラフト');
  });

  it('セッションが存在しない場合はundefinedを返す', () => {
    expect(getLatestDraft('nonexistent')).toBeUndefined();
  });

  it('assistantメッセージがない場合はundefinedを返す', () => {
    const session = makeSession({
      conversationHistory: [{ role: 'user', content: '要望のみ' }],
    });
    interactiveSessionManager.startSession(session);

    expect(getLatestDraft('1234567890.123456')).toBeUndefined();
  });
});

describe('handleApproveInternal', () => {
  const threadTs = '1234567890.123456';
  const messageTs = '1234567890.654321';

  beforeEach(() => {
    vi.clearAllMocks();
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('セッションが存在しない場合は何もしない', async () => {
    const deps = createMockDeps();

    await handleApproveInternal('nonexistent', messageTs, deps);

    expect(deps.writeStoryToVault).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('phaseがdraftingでない場合は何もしない', async () => {
    const session = makeSession({ phase: 'approved' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    expect(deps.writeStoryToVault).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('二重承認を防止する（CAS による排他制御）', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    // 1回目の承認は成功する
    await handleApproveInternal(threadTs, messageTs, deps);
    expect(deps.writeStoryToVault).toHaveBeenCalledTimes(1);

    // 2回目の承認はphaseがcompletedなので何もしない
    await handleApproveInternal(threadTs, messageTs, deps);
    expect(deps.writeStoryToVault).toHaveBeenCalledTimes(1);
  });

  it('正常系: Vaultにストーリーファイルを作成し、完了メッセージを投稿する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    // 1. Vaultにファイルを書き込む
    expect(deps.writeStoryToVault).toHaveBeenCalledTimes(1);
    const [project, parsed, slug] = (deps.writeStoryToVault as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(project).toBe('test-project');
    expect(parsed.title).toBe('Test Story');
    expect(parsed.value).toContain('テスト価値');
    expect(slug).toBe('test-story');

    // 2. ボタンを削除してメッセージを更新
    expect(deps.updateMessage).toHaveBeenCalledTimes(1);
    const updateCall = (deps.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.channel).toBe('C_TEST_CHANNEL');
    expect(updateCall.ts).toBe(messageTs);
    expect(updateCall.text).toContain('承認済み');

    // 3. 完了メッセージをスレッドに投稿
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.channel).toBe('C_TEST_CHANNEL');
    expect(postCall.thread_ts).toBe(threadTs);
    expect(postCall.text).toContain('ストーリーファイルを作成しました');
    expect(postCall.text).toContain('ファイルパス');
    expect(postCall.text).toContain('test-story');
  });

  it('セッションのphaseがcompletedに遷移する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    const updatedSession = interactiveSessionManager.getSession(threadTs);
    expect(updatedSession!.phase).toBe('completed');
  });

  it('ファイルにフロントマター（slug, title, status等）と本文が正しく含まれる', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    // writeStoryToVault に渡された parsed を検証
    const [, parsed] = (deps.writeStoryToVault as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(parsed.title).toBe('Test Story');
    expect(parsed.value).toContain('テスト価値');
    expect(parsed.acceptance).toContain('条件1');
    expect(parsed.tasks).toContain('タスク1');
  });

  it('ドラフトが見つからない場合はエラーメッセージを投稿する', async () => {
    const session = makeSession({
      conversationHistory: [{ role: 'user', content: 'テスト' }],
    });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    expect(deps.writeStoryToVault).not.toHaveBeenCalled();
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.text).toContain('ドラフトが見つかりません');
  });

  it('タイトルが抽出できない場合はエラーメッセージを投稿する', async () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: 'テスト' },
        { role: 'assistant', content: 'タイトルなしのドラフト' },
      ],
    });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    expect(deps.writeStoryToVault).not.toHaveBeenCalled();
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.text).toContain('タイトルを抽出できませんでした');
  });

  it('Vault書き込み失敗時に汎用エラーメッセージがスレッドに返される（内部情報は含まない）', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = createMockDeps({
      writeStoryToVault: vi.fn().mockImplementation(() => {
        throw new Error('Permission denied: /vault/stories');
      }),
    });

    await handleApproveInternal(threadTs, messageTs, deps);

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.text).toContain('Vaultへのストーリー作成に失敗しました');
    // 内部パス情報がユーザー向けメッセージに含まれないことを確認
    expect(postCall.text).not.toContain('Permission denied');
    expect(postCall.text).not.toContain('/vault/stories');
    expect(postCall.thread_ts).toBe(threadTs);

    // 詳細なエラー情報はconsole.errorに記録される
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[story-approval]'),
      expect.stringContaining('Permission denied'),
    );
    consoleSpy.mockRestore();
  });

  it('セッションのプロジェクトがVault書き込みに使用される', async () => {
    const session = makeSession({ project: 'custom-project' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    const [project] = (deps.writeStoryToVault as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(project).toBe('custom-project');
  });

  it('マルチターン後の最終ドラフトが使用される', async () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: '初回要望' },
        { role: 'assistant', content: '### タイトル\nFirst Draft\n\n### 価値・ゴール\n初回' },
        { role: 'user', content: 'タイトルを変更' },
        {
          role: 'assistant',
          content:
            '### タイトル\nFinal Draft\n\n### 価値・ゴール\n最終版\n\n### 受け入れ条件\n- [ ] 最終条件\n\n### タスク案\n1. 最終タスク',
        },
      ],
    });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleApproveInternal(threadTs, messageTs, deps);

    const [, parsed] = (deps.writeStoryToVault as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(parsed.title).toBe('Final Draft');
    expect(parsed.value).toContain('最終版');
  });
});

describe('handleCancelInternal', () => {
  const threadTs = '1234567890.123456';
  const messageTs = '1234567890.654321';

  beforeEach(() => {
    vi.clearAllMocks();
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('セッションが存在しない場合は何もしない', async () => {
    const deps = createMockDeps();

    await handleCancelInternal('nonexistent', messageTs, deps);

    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.updateMessage).not.toHaveBeenCalled();
  });

  it('phaseがdraftingでない場合は何もしない', async () => {
    const session = makeSession({ phase: 'completed' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleCancelInternal(threadTs, messageTs, deps);

    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('正常系: phaseをcancelledに遷移し、キャンセルメッセージを投稿する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleCancelInternal(threadTs, messageTs, deps);

    // 1. phaseがcancelledに遷移
    const updatedSession = interactiveSessionManager.getSession(threadTs);
    expect(updatedSession!.phase).toBe('cancelled');

    // 2. ボタンを削除してメッセージを更新
    expect(deps.updateMessage).toHaveBeenCalledTimes(1);
    const updateCall = (deps.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.text).toContain('キャンセル');

    // 3. キャンセルメッセージをスレッドに投稿
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.text).toContain('キャンセルしました');
    expect(postCall.thread_ts).toBe(threadTs);
  });
});
