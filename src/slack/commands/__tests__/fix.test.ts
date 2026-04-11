import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config', () => ({
  config: {
    watchProject: 'test-project',
    watchProjects: ['test-project'],
    vaultPath: '/vault',
    slack: { channelId: 'C_TEST_CHANNEL' },
  },
}));

import { handleFixInternal, buildFixAnalysisPrompt, extractProjectOption, type FixDraftDeps } from '../fix';
import { interactiveSessionManager } from '../../interactive-session';

function createMockDeps(overrides: Partial<FixDraftDeps> = {}): FixDraftDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '1111111111.111111' }),
    generateDraft: vi.fn().mockResolvedValue(
      '### タイトル\nfix: ログインエラー修正\n\n### 原因分析\nセッション管理の不具合\n\n### 修正方針\nセッション処理を修正\n\n### 受け入れ条件\n- [ ] ログインが成功する\n\n### 影響範囲\n認証モジュール',
    ),
    ...overrides,
  };
}

describe('buildFixAnalysisPrompt', () => {
  it('バグ説明をプロンプトに組み込む', () => {
    const prompt = buildFixAnalysisPrompt('ログインページで404が出る');

    expect(prompt).toContain('ログインページで404が出る');
    expect(prompt).toContain('タイトル');
    expect(prompt).toContain('原因分析');
    expect(prompt).toContain('修正方針');
    expect(prompt).toContain('受け入れ条件');
    expect(prompt).toContain('影響範囲');
  });
});

describe('handleFixInternal', () => {
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    respond = vi.fn().mockResolvedValue(undefined);
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('引数がない場合、使い方メッセージを返す', async () => {
    const deps = createMockDeps();

    await handleFixInternal([], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('バグの説明を指定してください');
    expect(msg).toContain('/ap fix');
    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.generateDraft).not.toHaveBeenCalled();
  });

  it('正常系: スレッドを作成し、分析を投稿し、セッションを登録する', async () => {
    const deps = createMockDeps();

    await handleFixInternal(['ログインで', '404エラー'], respond, deps);

    // 1. スレッド起点メッセージが投稿される
    expect(deps.postMessage).toHaveBeenCalledTimes(2);
    const rootCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rootCall.channel).toBe('C_TEST_CHANNEL');
    expect(rootCall.text).toContain('バグ修正');
    expect(rootCall.text).toContain('ログインで 404エラー');
    expect(rootCall.thread_ts).toBeUndefined();

    // 2. 分析がスレッドに投稿される（承認ボタン付き）
    const analysisCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(analysisCall.channel).toBe('C_TEST_CHANNEL');
    expect(analysisCall.thread_ts).toBe('1111111111.111111');
    expect(analysisCall.text).toContain('ログインエラー修正');

    // 承認ボタン（blocks）が含まれる
    expect(analysisCall.blocks).toBeDefined();
    expect(analysisCall.blocks).toHaveLength(2);
    const actionsBlock = analysisCall.blocks[1] as any;
    expect(actionsBlock.type).toBe('actions');
    expect(actionsBlock.elements[0].action_id).toBe('ap_fix_approve');
    expect(actionsBlock.elements[1].action_id).toBe('ap_fix_cancel');

    // 3. Claudeの分析生成が呼ばれる
    expect(deps.generateDraft).toHaveBeenCalledTimes(1);
    const prompt = (deps.generateDraft as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt).toContain('ログインで 404エラー');

    // 4. セッションが登録される（type: fix）
    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session).toBeDefined();
    expect(session!.phase).toBe('drafting');
    expect(session!.type).toBe('fix');
    expect(session!.description).toBe('ログインで 404エラー');
    expect(session!.channelId).toBe('C_TEST_CHANNEL');
    expect(session!.conversationHistory).toHaveLength(2);
    expect(session!.conversationHistory[0].role).toBe('user');
    expect(session!.conversationHistory[1].role).toBe('assistant');

    // 5. ephemeral メッセージが返される
    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('バグ分析をスレッドに投稿しました');
  });

  it('スレッド作成に失敗した場合（ts が undefined）、エラーメッセージを返す', async () => {
    const deps = createMockDeps({
      postMessage: vi.fn().mockResolvedValue({ ts: undefined }),
    });

    await handleFixInternal(['テスト'], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('スレッドの作成に失敗しました');
    expect(deps.generateDraft).not.toHaveBeenCalled();
  });

  it('Claude分析生成でエラーが発生した場合、エラーメッセージを返す', async () => {
    const deps = createMockDeps({
      generateDraft: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
    });

    await handleFixInternal(['テスト'], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('エラーが発生しました');
    expect(msg).toContain('API rate limit exceeded');
  });

  it('複数単語の引数がスペースで結合される', async () => {
    const deps = createMockDeps();

    await handleFixInternal(
      ['パスワード', 'リセット', 'リンクが', '404になる'],
      respond,
      deps,
    );

    const rootCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rootCall.text).toContain('パスワード リセット リンクが 404になる');

    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session!.description).toBe('パスワード リセット リンクが 404になる');
  });

  it('--project オプションでプロジェクトを指定できる', async () => {
    const deps = createMockDeps();

    await handleFixInternal(['--project=hoge', 'バグ説明'], respond, deps);

    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session).toBeDefined();
    expect(session!.project).toBe('hoge');
    expect(session!.description).toBe('バグ説明');
  });

  it('--project 未指定時は watchProjects[0] にフォールバックする', async () => {
    const deps = createMockDeps();

    await handleFixInternal(['バグ説明'], respond, deps);

    const session = interactiveSessionManager.getSession('1111111111.111111');
    expect(session).toBeDefined();
    expect(session!.project).toBe('test-project');
  });

  it('--project オプションが説明文に含まれない', async () => {
    const deps = createMockDeps();

    await handleFixInternal(['--project=hoge', 'バグ', '説明'], respond, deps);

    const rootCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(rootCall.text).toContain('バグ 説明');
    expect(rootCall.text).not.toContain('--project');
  });

  it('--project のみで説明がない場合はエラーメッセージを返す', async () => {
    const deps = createMockDeps();

    await handleFixInternal(['--project=hoge'], respond, deps);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('バグの説明を指定してください');
    expect(deps.postMessage).not.toHaveBeenCalled();
  });
});

describe('extractProjectOption', () => {
  it('--project=xxx を抽出して残りの引数を返す', () => {
    const result = extractProjectOption(['--project=hoge', 'バグ', '説明']);
    expect(result.project).toBe('hoge');
    expect(result.remainingArgs).toEqual(['バグ', '説明']);
  });

  it('--project がない場合は undefined を返す', () => {
    const result = extractProjectOption(['バグ', '説明']);
    expect(result.project).toBeUndefined();
    expect(result.remainingArgs).toEqual(['バグ', '説明']);
  });
});
