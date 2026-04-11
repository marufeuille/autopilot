import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config', () => ({
  config: {
    watchProject: 'test-project',
    watchProjects: ['test-project'],
    vaultPath: '/vault',
    slack: { channelId: 'C_TEST_CHANNEL' },
  },
}));

import { handleStoryInternal, buildStoryDraftPrompt, extractProjectOption, type StoryDraftDeps } from '../story';
import { interactiveSessionManager } from '../../interactive-session';

function createMockDeps(overrides: Partial<StoryDraftDeps> = {}): StoryDraftDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '1111111111.111111' }),
    generateDraft: vi.fn().mockResolvedValue(
      '### タイトル\nテストストーリー\n\n### 価値・ゴール\nテスト価値\n\n### 受け入れ条件\n- [ ] 条件1\n\n### タスク案\n1. タスク1',
    ),
    ...overrides,
  };
}

describe('buildStoryDraftPrompt', () => {
  it('ユーザーの要望をプロンプトに組み込む', () => {
    const prompt = buildStoryDraftPrompt('ユーザー管理画面を作る');

    expect(prompt).toContain('ユーザー管理画面を作る');
    expect(prompt).toContain('タイトル');
    expect(prompt).toContain('価値・ゴール');
    expect(prompt).toContain('受け入れ条件');
    expect(prompt).toContain('タスク案');
  });
});

describe('handleStoryInternal', () => {
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    respond = vi.fn().mockResolvedValue(undefined);
    // セッションマネージャーをクリーンアップ
    // endSession を使って既存セッションをクリア
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('引数がない場合、使い方メッセージを返す', async () => {
    const deps = createMockDeps();

    await handleStoryInternal([], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('ストーリーの概要を指定してください');
    expect(msg).toContain('/ap story');
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.generateDraft).not.toHaveBeenCalled();
  });

  it('正常系: スレッドを作成し、ドラフトを投稿し、セッションを登録する', async () => {
    const deps = createMockDeps();

    await handleStoryInternal(['アバター画像', 'アップロード機能'], respond, deps);

    // 1. スレッド起点メッセージが投稿される
    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    const rootCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rootCall.channel).toBe('C_TEST_CHANNEL');
    expect(rootCall.text).toContain('ストーリー作成');
    expect(rootCall.text).toContain('アバター画像 アップロード機能');
    expect(rootCall.thread_ts).toBeUndefined();

    // 2. ドラフトがスレッドに投稿される
    const draftCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(draftCall.channel).toBe('C_TEST_CHANNEL');
    expect(draftCall.thread_ts).toBe('1111111111.111111');
    expect(draftCall.text).toContain('テストストーリー');

    // 3. Claudeのドラフト生成が呼ばれる
    expect(deps.generateDraft).toHaveBeenCalledTimes(1);
    const prompt = (deps.generateDraft as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt).toContain('アバター画像 アップロード機能');

    // 4. セッションが登録される
    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session).toBeDefined();
    expect(session!.phase).toBe('drafting');
    expect(session!.type).toBe('story');
    expect(session!.description).toBe('アバター画像 アップロード機能');
    expect(session!.channelId).toBe('C_TEST_CHANNEL');
    expect(session!.conversationHistory).toHaveLength(2);
    expect(session!.conversationHistory[0].role).toBe('user');
    expect(session!.conversationHistory[1].role).toBe('assistant');

    // 5. ephemeral メッセージが返される
    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('ストーリードラフトをスレッドに投稿しました');
  });

  it('ドラフトにタイトル・価値/ゴール・受け入れ条件・タスク案が含まれる', async () => {
    const draftContent = [
      '### タイトル',
      'ユーザープロフィール画面にアバター機能追加',
      '',
      '### 価値・ゴール',
      'ユーザーが自分のプロフィール画像を設定できるようになる',
      '',
      '### 受け入れ条件',
      '- [ ] 画像アップロードができる',
      '- [ ] プロフィール画面に画像が表示される',
      '',
      '### タスク案',
      '1. 画像アップロードAPIの実装',
      '2. プロフィール画面UIの実装',
    ].join('\n');

    const deps = createMockDeps({
      generateDraft: vi.fn().mockResolvedValue(draftContent),
    });

    await handleStoryInternal(['アバター機能追加'], respond, deps);

    const draftCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(draftCall.text).toContain('タイトル');
    expect(draftCall.text).toContain('価値・ゴール');
    expect(draftCall.text).toContain('受け入れ条件');
    expect(draftCall.text).toContain('タスク案');
  });

  it('スレッド作成に失敗した場合（ts が undefined）、エラーメッセージを返す', async () => {
    const deps = createMockDeps({
      postMessage: vi.fn().mockResolvedValue({ ts: undefined }),
    });

    await handleStoryInternal(['テスト'], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('スレッドの作成に失敗しました');
    expect(deps.generateDraft).not.toHaveBeenCalled();
  });

  it('Claudeのドラフト生成でエラーが発生した場合、エラーメッセージを返す', async () => {
    const deps = createMockDeps({
      generateDraft: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
    });

    await handleStoryInternal(['テスト'], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('エラーが発生しました');
    expect(msg).toContain('API rate limit exceeded');
  });

  it('メッセージ投稿でエラーが発生した場合、エラーメッセージを返す', async () => {
    const postMessage = vi.fn()
      .mockResolvedValueOnce({ ts: '1111111111.111111' }) // 起点メッセージは成功
      .mockRejectedValueOnce(new Error('channel_not_found')); // ドラフト投稿は失敗

    const deps = createMockDeps({ postMessage });

    await handleStoryInternal(['テスト'], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('エラーが発生しました');
    expect(msg).toContain('channel_not_found');
  });

  it('複数単語の引数がスペースで結合される', async () => {
    const deps = createMockDeps();

    await handleStoryInternal(
      ['ユーザー', 'プロフィール', '画面に', 'アバター画像を追加'],
      respond,
      deps,
    );

    const rootCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rootCall.text).toContain('ユーザー プロフィール 画面に アバター画像を追加');

    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session!.description).toBe('ユーザー プロフィール 画面に アバター画像を追加');
  });

  it('--project オプションでプロジェクトを指定できる', async () => {
    const deps = createMockDeps();

    await handleStoryInternal(['--project=hoge', 'テスト概要'], respond, deps);

    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session).toBeDefined();
    expect(session!.project).toBe('hoge');
    expect(session!.description).toBe('テスト概要');
  });

  it('--project 未指定時は watchProjects[0] にフォールバックする', async () => {
    const deps = createMockDeps();

    await handleStoryInternal(['テスト概要'], respond, deps);

    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session).toBeDefined();
    expect(session!.project).toBe('test-project');
  });

  it('--project オプションが説明文に含まれない', async () => {
    const deps = createMockDeps();

    await handleStoryInternal(['--project=hoge', 'テスト', '概要'], respond, deps);

    const rootCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rootCall.text).toContain('テスト 概要');
    expect(rootCall.text).not.toContain('--project');
  });

  it('--project のみで説明がない場合はエラーメッセージを返す', async () => {
    const deps = createMockDeps();

    await handleStoryInternal(['--project=hoge'], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('ストーリーの概要を指定してください');
    expect(deps.postMessage).not.toHaveBeenCalled();
  });
});

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
