import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config', () => ({
  config: {
    watchProject: 'test-project',
    vaultPath: '/vault',
    slack: { channelId: 'C_TEST_CHANNEL' },
  },
  vaultStoriesPath: vi.fn().mockReturnValue('/vault/Projects/test-project/stories'),
}));

import {
  handleFixApproveInternal,
  handleFixCancelInternal,
  getLatestDraft,
  parseFixDraft,
  generateFixSlug,
  buildFixStoryFileContent,
  type FixApprovalDeps,
} from '../fix-approval';
import {
  interactiveSessionManager,
  type InteractiveSession,
} from '../../interactive-session';

function makeSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    threadTs: '1234567890.123456',
    channelId: 'C_TEST_CHANNEL',
    type: 'fix',
    phase: 'drafting',
    description: 'ログインで404エラー',
    conversationHistory: [
      { role: 'user', content: 'ログインで404エラー' },
      {
        role: 'assistant',
        content:
          '### タイトル\nfix: Login 404 Error\n\n### 原因分析\nルーティング設定の不備\n\n### 修正方針\nルーティングを修正する\n\n### 受け入れ条件\n- [ ] ログインが正常に動作する\n\n### 影響範囲\n認証モジュール',
      },
    ],
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<FixApprovalDeps> = {}): FixApprovalDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '9999999999.999999' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    writeFixStoryToVault: vi.fn().mockReturnValue('/vault/Projects/test-project/stories/fix-login-404-error.md'),
    ...overrides,
  };
}

describe('parseFixDraft', () => {
  it('fix分析ドラフトを正しくパースする', () => {
    const draft = [
      '### タイトル',
      'fix: ログインエラー修正',
      '',
      '### 原因分析',
      'セッション管理の不具合',
      '',
      '### 修正方針',
      'セッション処理を修正する',
      '',
      '### 受け入れ条件',
      '- [ ] ログインが成功する',
      '',
      '### 影響範囲',
      '認証モジュール',
    ].join('\n');

    const parsed = parseFixDraft(draft);

    expect(parsed.title).toBe('fix: ログインエラー修正');
    expect(parsed.analysis).toBe('セッション管理の不具合');
    expect(parsed.approach).toBe('セッション処理を修正する');
    expect(parsed.acceptance).toContain('ログインが成功する');
    expect(parsed.impact).toBe('認証モジュール');
  });

  it('セクションが存在しない場合は空文字列を返す', () => {
    const parsed = parseFixDraft('何もないテキスト');

    expect(parsed.title).toBe('');
    expect(parsed.analysis).toBe('');
    expect(parsed.approach).toBe('');
    expect(parsed.acceptance).toBe('');
    expect(parsed.impact).toBe('');
  });
});

describe('generateFixSlug', () => {
  it('fix: プレフィックス付きタイトルからスラッグを生成する', () => {
    expect(generateFixSlug('fix: Login Error')).toBe('fix-login-error');
  });

  it('fix: プレフィックスなしでも動作する', () => {
    expect(generateFixSlug('Session Bug')).toBe('fix-session-bug');
  });

  it('日本語タイトルの場合はタイムスタンプベースのスラッグ', () => {
    const now = new Date('2025-01-15T10:30:00Z');
    expect(generateFixSlug('ログインバグ', now)).toBe('fix-20250115-103000');
  });
});

describe('buildFixStoryFileContent', () => {
  it('status: Doing でストーリーファイルを構築する', () => {
    const parsed = {
      title: 'fix: Login Error',
      analysis: 'ルーティング設定の不備',
      approach: 'ルーティングを修正する',
      acceptance: '- [ ] ログインが正常に動作する',
      impact: '認証モジュール',
    };

    const content = buildFixStoryFileContent(parsed, 'fix-login-error', 'test-project');

    expect(content).toContain('status: Doing');
    expect(content).toContain('priority: high');
    expect(content).toContain('slug: fix-login-error');
    expect(content).toContain('project: test-project');
    expect(content).toContain('# fix: Login Error');
    expect(content).toContain('ルーティング設定の不備');
    expect(content).toContain('ルーティングを修正する');
    expect(content).toContain('ログインが正常に動作する');
    expect(content).toContain('認証モジュール');
  });
});

describe('getLatestDraft', () => {
  beforeEach(() => {
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('セッションの最後のassistantメッセージを返す', () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: '要望' },
        { role: 'assistant', content: '初回分析' },
        { role: 'user', content: '修正依頼' },
        { role: 'assistant', content: '最終分析' },
      ],
    });
    interactiveSessionManager.startSession(session);

    const draft = getLatestDraft('1234567890.123456');
    expect(draft).toBe('最終分析');
  });

  it('セッションが存在しない場合はundefinedを返す', () => {
    expect(getLatestDraft('nonexistent')).toBeUndefined();
  });
});

describe('handleFixApproveInternal', () => {
  const threadTs = '1234567890.123456';
  const messageTs = '1234567890.654321';

  beforeEach(() => {
    vi.clearAllMocks();
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('セッションが存在しない場合は何もしない', async () => {
    const deps = createMockDeps();

    await handleFixApproveInternal('nonexistent', messageTs, deps, 'U_TEST');

    expect(deps.writeFixStoryToVault).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('phaseがdraftingでない場合は何もしない', async () => {
    const session = makeSession({ phase: 'approved' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');

    expect(deps.writeFixStoryToVault).not.toHaveBeenCalled();
    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('二重承認を防止する（CAS による排他制御）', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    // 1回目の承認は成功する
    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');
    expect(deps.writeFixStoryToVault).toHaveBeenCalledTimes(1);

    // 2回目の承認はphaseがexecutingなので何もしない
    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');
    expect(deps.writeFixStoryToVault).toHaveBeenCalledTimes(1);
  });

  it('正常系: Vaultにfix用ストーリーファイルを作成し、実行開始を通知する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');

    // 1. Vaultにファイルを書き込む
    expect(deps.writeFixStoryToVault).toHaveBeenCalledTimes(1);
    const [project, content, slug] = (deps.writeFixStoryToVault as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(project).toBe('test-project');
    expect(content).toContain('status: Doing');
    expect(slug).toBe('fix-login-404-error');

    // 2. ボタンを削除してメッセージを更新
    expect(deps.updateMessage).toHaveBeenCalledTimes(1);
    const updateCall = (deps.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall.channel).toBe('C_TEST_CHANNEL');
    expect(updateCall.ts).toBe(messageTs);
    expect(updateCall.text).toContain('承認済み');

    // 3. 実行開始メッセージをスレッドに投稿
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.channel).toBe('C_TEST_CHANNEL');
    expect(postCall.thread_ts).toBe(threadTs);
    expect(postCall.text).toContain('修正を開始しました');
    expect(postCall.text).toContain('ストーリーファイル');
    expect(postCall.text).toContain('fix-login-404-error');
  });

  it('phaseが drafting → approved → executing と遷移する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    // 初期状態: drafting
    expect(interactiveSessionManager.getSession(threadTs)!.phase).toBe('drafting');

    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');

    // 最終状態: executing
    const updatedSession = interactiveSessionManager.getSession(threadTs);
    expect(updatedSession!.phase).toBe('executing');
  });

  it('ドラフトが見つからない場合はエラーメッセージを投稿する', async () => {
    const session = makeSession({
      conversationHistory: [{ role: 'user', content: 'テスト' }],
    });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');

    expect(deps.writeFixStoryToVault).not.toHaveBeenCalled();
    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.text).toContain('分析ドラフトが見つかりません');
  });

  it('タイトルが抽出できない場合はエラーメッセージを投稿しdraftingに戻る', async () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: 'テスト' },
        { role: 'assistant', content: 'タイトルなしの分析' },
      ],
    });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');

    expect(deps.writeFixStoryToVault).not.toHaveBeenCalled();
    // phaseがdraftingに戻ることを確認
    expect(interactiveSessionManager.getSession(threadTs)!.phase).toBe('drafting');
  });

  it('Vault書き込み失敗時に汎用エラーメッセージがスレッドに返される', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = createMockDeps({
      writeFixStoryToVault: vi.fn().mockImplementation(() => {
        throw new Error('Permission denied: /vault/stories');
      }),
    });

    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');

    expect(deps.postMessage).toHaveBeenCalledTimes(1);
    const postCall = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(postCall.text).toContain('fix用ストーリーの作成に失敗しました');
    expect(postCall.text).not.toContain('Permission denied');
    expect(postCall.thread_ts).toBe(threadTs);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[fix-approval]'),
      expect.stringContaining('Permission denied'),
    );
    consoleSpy.mockRestore();
  });

  it('マルチターン後の最終分析が使用される', async () => {
    const session = makeSession({
      conversationHistory: [
        { role: 'user', content: '初回報告' },
        { role: 'assistant', content: '### タイトル\nfix: First Analysis\n\n### 原因分析\n初回' },
        { role: 'user', content: '原因が違う' },
        {
          role: 'assistant',
          content:
            '### タイトル\nfix: Final Analysis\n\n### 原因分析\n最終版分析\n\n### 修正方針\n最終修正方針\n\n### 受け入れ条件\n- [ ] 最終条件\n\n### 影響範囲\n最終影響範囲',
        },
      ],
    });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleFixApproveInternal(threadTs, messageTs, deps, 'U_TEST');

    const [, content] = (deps.writeFixStoryToVault as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(content).toContain('fix: Final Analysis');
    expect(content).toContain('最終版分析');
  });
});

describe('handleFixCancelInternal', () => {
  const threadTs = '1234567890.123456';
  const messageTs = '1234567890.654321';

  beforeEach(() => {
    vi.clearAllMocks();
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('セッションが存在しない場合は何もしない', async () => {
    const deps = createMockDeps();

    await handleFixCancelInternal('nonexistent', messageTs, deps, 'U_TEST');

    expect(deps.postMessage).not.toHaveBeenCalled();
    expect(deps.updateMessage).not.toHaveBeenCalled();
  });

  it('phaseがdraftingでない場合は何もしない', async () => {
    const session = makeSession({ phase: 'executing' });
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleFixCancelInternal(threadTs, messageTs, deps, 'U_TEST');

    expect(deps.postMessage).not.toHaveBeenCalled();
  });

  it('正常系: phaseをcancelledに遷移し、キャンセルメッセージを投稿する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const deps = createMockDeps();

    await handleFixCancelInternal(threadTs, messageTs, deps, 'U_TEST');

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
    expect(postCall.text).toContain('/ap fix');
    expect(postCall.thread_ts).toBe(threadTs);
  });
});
