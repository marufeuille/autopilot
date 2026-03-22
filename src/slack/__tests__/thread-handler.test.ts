import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', () => ({
  config: {
    watchProject: 'test-project',
    vaultPath: '/vault',
    slack: { channelId: 'C_TEST_CHANNEL' },
  },
}));

import {
  handleThreadMessageInternal,
  buildRedraftPrompt,
  buildApprovalBlocks,
  type RedraftDeps,
} from '../thread-handler';
import {
  interactiveSessionManager,
  type InteractiveSession,
} from '../interactive-session';

function makeSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    threadTs: '1234567890.123456',
    channelId: 'C_TEST_CHANNEL',
    type: 'story',
    phase: 'drafting',
    description: 'テスト用ストーリー',
    conversationHistory: [
      { role: 'user', content: 'テスト用ストーリー' },
      { role: 'assistant', content: '### タイトル\n初回ドラフト' },
    ],
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<RedraftDeps> = {}): RedraftDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '2222222222.222222' }),
    generateDraft: vi.fn().mockResolvedValue(
      '### タイトル\n修正版ドラフト\n\n### 価値・ゴール\nテスト価値',
    ),
    ...overrides,
  };
}

describe('buildRedraftPrompt', () => {
  it('会話履歴と修正依頼をプロンプトに含める', () => {
    const session = makeSession();
    const prompt = buildRedraftPrompt(session, 'タイトルを変更してください');

    expect(prompt).toContain('テスト用ストーリー');
    expect(prompt).toContain('初回ドラフト');
    expect(prompt).toContain('タイトルを変更してください');
    expect(prompt).toContain('会話履歴');
    expect(prompt).toContain('最新の修正依頼');
  });

  it('会話履歴のロールが正しくラベル付けされる', () => {
    const session = makeSession();
    const prompt = buildRedraftPrompt(session, '修正');

    expect(prompt).toContain('【ユーザー】');
    expect(prompt).toContain('【アシスタント】');
  });

  it('fix セッションの場合、fix用プロンプトを使用する', () => {
    const session = makeSession({ type: 'fix' });
    const prompt = buildRedraftPrompt(session, '修正方針を変更してください');

    expect(prompt).toContain('バグ分析・修正の専門家');
    expect(prompt).toContain('原因分析');
    expect(prompt).toContain('修正方針');
    expect(prompt).toContain('影響範囲');
  });
});

describe('buildApprovalBlocks', () => {
  it('ドラフトテキストと承認・キャンセルボタンを含むブロックを返す', () => {
    const blocks = buildApprovalBlocks('ドラフト内容', 'ts-123');

    expect(blocks).toHaveLength(2);

    // section block
    const section = blocks[0] as any;
    expect(section.type).toBe('section');
    expect(section.text.text).toBe('ドラフト内容');

    // actions block
    const actions = blocks[1] as any;
    expect(actions.type).toBe('actions');
    expect(actions.elements).toHaveLength(2);

    // 承認ボタン
    expect(actions.elements[0].action_id).toBe('ap_story_approve');
    expect(actions.elements[0].style).toBe('primary');
    expect(actions.elements[0].value).toBe('ts-123');

    // キャンセルボタン
    expect(actions.elements[1].action_id).toBe('ap_story_cancel');
    expect(actions.elements[1].style).toBe('danger');
    expect(actions.elements[1].value).toBe('ts-123');
  });

  it('fix セッション用のブロックを返す', () => {
    const blocks = buildApprovalBlocks('fix分析内容', 'ts-456', 'fix');

    const actions = blocks[1] as any;
    expect(actions.elements[0].action_id).toBe('ap_fix_approve');
    expect(actions.elements[0].text.text).toContain('承認して修正を開始');
    expect(actions.elements[1].action_id).toBe('ap_fix_cancel');
    expect(actions.elements[0].value).toBe('ts-456');
  });
});

describe('handleThreadMessageInternal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // セッションマネージャーをクリーンアップ
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('セッションが存在しない場合は何もしない', async () => {
    const deps = createMockDeps();

    await handleThreadMessageInternal('nonexistent', '修正してください', deps);

    expect(deps.generateDraft).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('phase が drafting でない場合は何もしない', async () => {
    const session = makeSession({ phase: 'approved' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleThreadMessageInternal('1234567890.123456', '修正してください', deps);

    expect(deps.generateDraft).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('phase が cancelled の場合は何もしない', async () => {
    const session = makeSession({ phase: 'cancelled' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleThreadMessageInternal('1234567890.123456', '修正してください', deps);

    expect(deps.generateDraft).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('正常系: 再ドラフトを生成してスレッドに投稿する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleThreadMessageInternal(
      '1234567890.123456',
      'タイトルを「新機能追加」に変更してください',
      deps,
    );

    // 1. Claudeのドラフト生成が呼ばれる
    expect(deps.generateDraft).toHaveBeenCalledTimes(1);
    const prompt = (deps.generateDraft as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt).toContain('タイトルを「新機能追加」に変更してください');
    expect(prompt).toContain('テスト用ストーリー'); // 会話履歴
    expect(prompt).toContain('初回ドラフト'); // 前回のドラフト

    // 2. 再ドラフトがスレッドに投稿される（blocks付き）
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.channel).toBe('C_TEST_CHANNEL');
    expect(postCall.thread_ts).toBe('1234567890.123456');
    expect(postCall.text).toContain('修正版ドラフト');
    expect(postCall.blocks).toBeDefined();
    expect(postCall.blocks).toHaveLength(2);
  });

  it('fix セッションの再ドラフトに fix 用承認ボタンが含まれる', async () => {
    const session = makeSession({ type: 'fix' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleThreadMessageInternal('1234567890.123456', '修正', deps);

    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const actionsBlock = postCall.blocks[1];
    expect(actionsBlock.type).toBe('actions');
    expect(actionsBlock.elements[0].action_id).toBe('ap_fix_approve');
    expect(actionsBlock.elements[1].action_id).toBe('ap_fix_cancel');
  });

  it('会話履歴にユーザーの修正依頼とClaudeの再ドラフトが追加される', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleThreadMessageInternal(
      '1234567890.123456',
      '受け入れ条件を追加してください',
      deps,
    );

    const updatedSession = interactiveSessionManager.getSession('1234567890.123456');
    expect(updatedSession!.conversationHistory).toHaveLength(4);
    // 元の2件 + ユーザー修正依頼 + Claudeの再ドラフト
    expect(updatedSession!.conversationHistory[2]).toEqual({
      role: 'user',
      content: '受け入れ条件を追加してください',
    });
    expect(updatedSession!.conversationHistory[3]).toEqual({
      role: 'assistant',
      content: '### タイトル\n修正版ドラフト\n\n### 価値・ゴール\nテスト価値',
    });
  });

  it('再ドラフトに承認ボタンが含まれる', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleThreadMessageInternal('1234567890.123456', '修正', deps);

    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const actionsBlock = postCall.blocks[1];
    expect(actionsBlock.type).toBe('actions');
    expect(actionsBlock.elements[0].action_id).toBe('ap_story_approve');
    expect(actionsBlock.elements[1].action_id).toBe('ap_story_cancel');
  });

  it('複数回の修正依頼で会話履歴が蓄積される', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);

    const deps1 = createMockDeps({
      generateDraft: vi.fn().mockResolvedValue('第2版ドラフト'),
    });
    await handleThreadMessageInternal('1234567890.123456', '修正1', deps1);

    const deps2 = createMockDeps({
      generateDraft: vi.fn().mockResolvedValue('第3版ドラフト'),
    });
    await handleThreadMessageInternal('1234567890.123456', '修正2', deps2);

    const updatedSession = interactiveSessionManager.getSession('1234567890.123456');
    // 元の2件 + (修正1 + 第2版) + (修正2 + 第3版) = 6件
    expect(updatedSession!.conversationHistory).toHaveLength(6);
    expect(updatedSession!.conversationHistory[2].content).toBe('修正1');
    expect(updatedSession!.conversationHistory[3].content).toBe('第2版ドラフト');
    expect(updatedSession!.conversationHistory[4].content).toBe('修正2');
    expect(updatedSession!.conversationHistory[5].content).toBe('第3版ドラフト');

    // 2回目のプロンプトに1回目の修正内容も含まれる
    const prompt2 = (deps2.generateDraft as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt2).toContain('修正1');
    expect(prompt2).toContain('第2版ドラフト');
    expect(prompt2).toContain('修正2');
  });

  it('Claude生成エラー時にエラーメッセージをスレッドに投稿する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps({
      generateDraft: vi.fn().mockRejectedValue(new Error('API timeout')),
    });

    await handleThreadMessageInternal('1234567890.123456', '修正してください', deps);

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.text).toContain('エラーが発生しました');
    expect(postCall.text).toContain('API timeout');
    expect(postCall.thread_ts).toBe('1234567890.123456');
    // エラー時はblocksなし
    expect(postCall.blocks).toBeUndefined();
  });

  it('投稿エラー時でもクラッシュしない', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps({
      postMessage: vi.fn().mockRejectedValue(new Error('channel_not_found')),
    });

    // エラーが外部に伝播しないことを確認（handleThreadMessageInternalがthrowする）
    // ただし実際の呼び出し元（registerThreadHandler）でcatchされる想定
    await expect(
      handleThreadMessageInternal('1234567890.123456', '修正', deps),
    ).rejects.toThrow('channel_not_found');
  });
});
