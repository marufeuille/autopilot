/**
 * /ap fix コマンド インタラクティブフロー結合テスト
 *
 * コマンド受信から承認・却下までの一連のフローが回帰しないよう、
 * 結合テストで品質を担保する。
 *
 * シナリオ:
 * 1. /ap fix → 分析結果投稿 → スレッド返信で承認 → 修正実行 → 結果投稿
 * 2. /ap fix → 分析結果投稿 → ボタンで承認 → 修正実行 → 結果投稿
 * 3. /ap fix → 分析結果投稿 → 却下 → 終了メッセージ
 * 4. 異常系（セッション不在・APIエラー）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// config モック
// ---------------------------------------------------------------------------
vi.mock('../../config', () => ({
  config: {
    watchProject: 'test-project',
    vaultPath: '/vault',
    slack: { channelId: 'C_E2E_CHANNEL' },
  },
  vaultStoriesPath: vi.fn().mockReturnValue('/vault/Projects/test-project/stories'),
}));

// ---------------------------------------------------------------------------
// モック設定後にインポート
// ---------------------------------------------------------------------------
import { handleFixInternal, type FixDraftDeps } from '../../slack/commands/fix';
import {
  handleFixApproveInternal,
  handleFixCancelInternal,
  type FixApprovalDeps,
} from '../../slack/actions/fix-approval';
import {
  executeFixInternal,
  type FixExecutionDeps,
  FixExecutionTimeoutError,
} from '../../slack/actions/fix-executor';
import {
  handleThreadMessageInternal,
  type RedraftDeps,
} from '../../slack/thread-handler';
import {
  interactiveSessionManager,
  type InteractiveSession,
} from '../../slack/interactive-session';

// ---------------------------------------------------------------------------
// ログキャプチャ用ユーティリティ
// ---------------------------------------------------------------------------
let logOutput: string[] = [];

function captureConsoleLogs() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const capture = (...args: unknown[]) => {
    logOutput.push(args.map(String).join(' '));
  };

  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);

  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  };
}

function assertLogContains(phase: string) {
  const found = logOutput.some((line) => line.includes(phase));
  expect(found, `ログに phase="${phase}" が含まれること`).toBe(true);
}

function assertLogContainsAll(phases: string[]) {
  for (const phase of phases) {
    assertLogContains(phase);
  }
}

// ---------------------------------------------------------------------------
// 共通モックファクトリ
// ---------------------------------------------------------------------------
const THREAD_TS = '1700000000.000001';
const MESSAGE_TS = '1700000000.000002';
const PROGRESS_TS = '1700000000.000003';
const CHANNEL_ID = 'C_E2E_CHANNEL';
const USER_ID = 'U_E2E_USER';

const MOCK_ANALYSIS = `### タイトル
fix: Login 404 Error

### 原因分析
ルーティング設定の不備。/login パスが routes.ts に定義されていない。

### 修正方針
routes.ts にログインルートを追加し、対応するコンポーネントをインポートする。

### 受け入れ条件
- [ ] /login にアクセスしたときに 404 が出ない
- [ ] ログイン画面が正常に表示される

### 影響範囲
認証モジュール、ルーティング設定`;

const MOCK_REDRAFT = `### タイトル
fix: Login 404 Error (修正版)

### 原因分析
ルーティング設定の不備に加え、ミドルウェアの認証チェックも原因。

### 修正方針
routes.ts にログインルートを追加し、認証ミドルウェアから除外する。

### 受け入れ条件
- [ ] /login にアクセスしたときに 404 が出ない
- [ ] ログイン画面が正常に表示される
- [ ] 認証ミドルウェアが /login をスキップする

### 影響範囲
認証モジュール、ルーティング設定、ミドルウェア`;

const MOCK_FIX_RESULT = `### 修正サマリー
routes.ts にログインルートを追加し、認証ミドルウェアから /login を除外しました。

### 変更ファイル
- src/routes.ts: ログインルートの追加
- src/middleware/auth.ts: /login パスの除外設定

### 確認結果
全ての受け入れ条件をクリアしました。`;

function createFixDraftDeps(overrides: Partial<FixDraftDeps> = {}): FixDraftDeps {
  return {
    postMessage: vi.fn()
      .mockResolvedValueOnce({ ts: THREAD_TS }) // root message
      .mockResolvedValue({ ts: MESSAGE_TS }),    // subsequent messages
    generateDraft: vi.fn().mockResolvedValue(MOCK_ANALYSIS),
    ...overrides,
  };
}

function createFixApprovalDeps(overrides: Partial<FixApprovalDeps> = {}): FixApprovalDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '9999999999.999999' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    writeFixStoryToVault: vi.fn().mockReturnValue(
      '/vault/Projects/test-project/stories/fix-login-404-error.md',
    ),
    runFixAgent: vi.fn().mockResolvedValue(MOCK_FIX_RESULT),
    ...overrides,
  };
}

function createRedraftDeps(overrides: Partial<RedraftDeps> = {}): RedraftDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: MESSAGE_TS }),
    generateDraft: vi.fn().mockResolvedValue(MOCK_REDRAFT),
    ...overrides,
  };
}

function createExecutionDeps(overrides: Partial<FixExecutionDeps> = {}): FixExecutionDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: PROGRESS_TS }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    runFixAgent: vi.fn().mockResolvedValue(MOCK_FIX_RESULT),
    ...overrides,
  };
}

/**
 * セッションマネージャーを手動でクリアするヘルパー
 */
function clearAllSessions() {
  // InteractiveSessionManager はシングルトンなのでセッションを全てクリアする
  const mgr = interactiveSessionManager as any;
  if (mgr.sessions) {
    mgr.sessions.clear();
  }
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------
describe('/ap fix E2E integration', () => {
  let restoreLogs: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllSessions();
    logOutput = [];
    restoreLogs = captureConsoleLogs();
  });

  afterEach(() => {
    restoreLogs?.();
    clearAllSessions();
  });

  // =========================================================================
  // シナリオ 1: スレッド返信で再ドラフト → ボタンで承認 → 修正実行 → 結果投稿
  // =========================================================================
  describe('シナリオ1: スレッド返信承認フロー', () => {
    it('/ap fix → 分析結果投稿 → スレッド返信で再ドラフト → ボタン承認 → 修正実行 → 結果投稿', async () => {
      // --- Step 1: /ap fix コマンド実行 ---
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);

      await handleFixInternal(
        ['ログインページで', '404エラーが発生する'],
        respond,
        draftDeps,
      );

      // コマンド受信・分析・結果投稿・セッション登録のログを検証
      assertLogContainsAll([
        'command_received',
        'thread_creation',
        'analysis_start',
        'analysis_complete',
        'result_posted',
        'session_registered',
      ]);

      // セッションが登録されていることを確認
      const session = interactiveSessionManager.getSession(THREAD_TS);
      expect(session).toBeDefined();
      expect(session!.phase).toBe('drafting');
      expect(session!.type).toBe('fix');
      expect(session!.conversationHistory).toHaveLength(2);

      // respond にエフェメラルメッセージが返されていること
      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('バグ分析をスレッドに投稿しました'),
      );

      // --- Step 2: スレッド返信で再ドラフト ---
      const redraftDeps = createRedraftDeps();

      await handleThreadMessageInternal(
        THREAD_TS,
        '認証ミドルウェアの確認もお願いします',
        redraftDeps,
      );

      // 再ドラフトのログを検証
      assertLogContainsAll([
        'thread_message_received',
        'redraft_start',
        'redraft_complete',
        'redraft_posted',
      ]);

      // 会話履歴が更新されていること（user + assistant 追加 = 4件）
      const sessionAfterRedraft = interactiveSessionManager.getSession(THREAD_TS);
      expect(sessionAfterRedraft!.conversationHistory).toHaveLength(4);
      expect(sessionAfterRedraft!.phase).toBe('drafting');

      // 再ドラフトが承認ボタン付きで投稿されていること
      expect(redraftDeps.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: CHANNEL_ID,
          thread_ts: THREAD_TS,
          blocks: expect.arrayContaining([
            expect.objectContaining({ type: 'actions' }),
          ]),
        }),
      );

      // --- Step 3: ボタンで承認 → 修正実行 ---
      const approvalDeps = createFixApprovalDeps();

      await handleFixApproveInternal(
        THREAD_TS,
        MESSAGE_TS,
        approvalDeps,
        USER_ID,
      );

      // 承認・実行のログを検証
      assertLogContainsAll([
        'approve_received',
        'approve_phase_transition',
        'approve_parsed',
        'vault_write_start',
        'vault_write_complete',
        'execution_start',
        'execution_notified',
      ]);

      // Vault にストーリーファイルが書き込まれたこと
      expect(approvalDeps.writeFixStoryToVault).toHaveBeenCalledWith(
        'test-project',
        expect.stringContaining('status: Doing'),
        expect.stringMatching(/^fix-/),
      );

      // ボタンメッセージが「承認済み」に更新されたこと
      expect(approvalDeps.updateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('承認済み'),
        }),
      );

      // 修正実行が呼ばれたこと（runFixAgent が呼ばれていること）
      expect(approvalDeps.runFixAgent).toHaveBeenCalled();

      // セッションが completed になっていること
      const finalSession = interactiveSessionManager.getSession(THREAD_TS);
      expect(finalSession!.phase).toBe('completed');
    });
  });

  // =========================================================================
  // シナリオ 2: ボタンで直接承認（再ドラフトなし）→ 修正実行 → 結果投稿
  // =========================================================================
  describe('シナリオ2: ボタン直接承認フロー', () => {
    it('/ap fix → 分析結果投稿 → ボタン承認 → 修正実行 → 結果投稿', async () => {
      // --- Step 1: /ap fix コマンド実行 ---
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);

      await handleFixInternal(
        ['APIレスポンスが500を返す'],
        respond,
        draftDeps,
      );

      expect(interactiveSessionManager.getSession(THREAD_TS)).toBeDefined();
      assertLogContains('session_registered');

      // --- Step 2: ボタンで即座に承認 ---
      const approvalDeps = createFixApprovalDeps();

      await handleFixApproveInternal(
        THREAD_TS,
        MESSAGE_TS,
        approvalDeps,
        USER_ID,
      );

      // フルフローのログが出力されていること
      assertLogContainsAll([
        'approve_received',
        'approve_phase_transition',
        'vault_write_start',
        'vault_write_complete',
        'execution_start',
      ]);

      // Vault にファイルが書き込まれたこと
      expect(approvalDeps.writeFixStoryToVault).toHaveBeenCalled();

      // 実行が完了していること
      const session = interactiveSessionManager.getSession(THREAD_TS);
      expect(session!.phase).toBe('completed');
    });
  });

  // =========================================================================
  // シナリオ 3: 却下フロー
  // =========================================================================
  describe('シナリオ3: 却下フロー', () => {
    it('/ap fix → 分析結果投稿 → キャンセルボタン → 終了メッセージ', async () => {
      // --- Step 1: /ap fix コマンド実行 ---
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);

      await handleFixInternal(
        ['CSSが崩れる問題'],
        respond,
        draftDeps,
      );

      const session = interactiveSessionManager.getSession(THREAD_TS);
      expect(session).toBeDefined();
      expect(session!.phase).toBe('drafting');

      // --- Step 2: キャンセルボタン ---
      const approvalDeps = createFixApprovalDeps();

      await handleFixCancelInternal(
        THREAD_TS,
        MESSAGE_TS,
        approvalDeps,
        USER_ID,
      );

      // キャンセルのログを検証
      assertLogContainsAll([
        'cancel_received',
        'cancel_phase_transition',
      ]);

      // セッションが cancelled になっていること
      const cancelledSession = interactiveSessionManager.getSession(THREAD_TS);
      expect(cancelledSession!.phase).toBe('cancelled');

      // ボタンメッセージが「キャンセル」に更新されたこと
      expect(approvalDeps.updateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('キャンセル'),
        }),
      );

      // キャンセルメッセージがスレッドに投稿されたこと
      expect(approvalDeps.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: THREAD_TS,
          text: expect.stringContaining('キャンセル'),
        }),
      );

      // Vault にファイルが書き込まれていないこと
      expect(approvalDeps.writeFixStoryToVault).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // シナリオ 4: 異常系
  // =========================================================================
  describe('シナリオ4: 異常系', () => {
    // -----------------------------------------------------------------------
    // 4-1: セッション不在時の承認
    // -----------------------------------------------------------------------
    it('セッション不在時にボタン承認しても安全に無視される', async () => {
      const approvalDeps = createFixApprovalDeps();

      // セッションが存在しない threadTs で承認を試行
      await handleFixApproveInternal(
        'nonexistent.thread.ts',
        MESSAGE_TS,
        approvalDeps,
        USER_ID,
      );

      // ログに警告が記録されること
      assertLogContains('approve_received');

      // Vault への書き込みが行われないこと
      expect(approvalDeps.writeFixStoryToVault).not.toHaveBeenCalled();

      // メッセージ更新が行われないこと
      expect(approvalDeps.updateMessage).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 4-2: セッション不在時のキャンセル
    // -----------------------------------------------------------------------
    it('セッション不在時にキャンセルしても安全に無視される', async () => {
      const approvalDeps = createFixApprovalDeps();

      await handleFixCancelInternal(
        'nonexistent.thread.ts',
        MESSAGE_TS,
        approvalDeps,
        USER_ID,
      );

      // 操作が行われないこと
      expect(approvalDeps.updateMessage).not.toHaveBeenCalled();
      expect(approvalDeps.postMessage).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 4-3: 二重承認の防止
    // -----------------------------------------------------------------------
    it('二重承認（CAS失敗）時は 2回目の承認が無視される', async () => {
      // セッション準備
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleFixInternal(['バグ'], respond, draftDeps);

      // 1回目の承認
      const approvalDeps1 = createFixApprovalDeps();
      await handleFixApproveInternal(THREAD_TS, MESSAGE_TS, approvalDeps1, USER_ID);

      expect(approvalDeps1.writeFixStoryToVault).toHaveBeenCalled();

      // 2回目の承認（phase は既に executing/completed なので CAS 失敗するべき）
      const approvalDeps2 = createFixApprovalDeps();
      await handleFixApproveInternal(THREAD_TS, MESSAGE_TS, approvalDeps2, USER_ID);

      // 2回目は Vault 書き込みが行われないこと
      expect(approvalDeps2.writeFixStoryToVault).not.toHaveBeenCalled();

      // CAS 失敗のログが出力されていること
      assertLogContains('approve_cas_failed');
    });

    // -----------------------------------------------------------------------
    // 4-4: Claude API エラー（分析生成時）
    // -----------------------------------------------------------------------
    it('分析生成中の API エラーでエラーメッセージが返される', async () => {
      const draftDeps = createFixDraftDeps({
        generateDraft: vi.fn().mockRejectedValue(new Error('Anthropic API overloaded')),
      });
      const respond = vi.fn().mockResolvedValue(undefined);

      await handleFixInternal(['バグ説明'], respond, draftDeps);

      // エラーのログが出力されていること
      assertLogContains('error');

      // エラーメッセージが respond に返されること
      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('エラーが発生しました'),
      );
    });

    // -----------------------------------------------------------------------
    // 4-5: 修正実行中の API エラー
    // -----------------------------------------------------------------------
    it('修正実行中の API エラーでエラーメッセージがスレッドに投稿される', async () => {
      // セッション準備（executing phase）
      const session: InteractiveSession = {
        threadTs: THREAD_TS,
        channelId: CHANNEL_ID,
        type: 'fix',
        phase: 'executing',
        description: 'バグ修正',
        conversationHistory: [
          { role: 'user', content: 'バグ修正' },
          { role: 'assistant', content: MOCK_ANALYSIS },
        ],
      };
      interactiveSessionManager.startSession(session);

      const executionDeps = createExecutionDeps({
        runFixAgent: vi.fn().mockRejectedValue(new Error('Anthropic rate limit exceeded')),
      });

      const parsed = {
        title: 'fix: Login 404 Error',
        analysis: 'ルーティング設定の不備',
        approach: 'ルーティングを修正する',
        acceptance: '- [ ] ログインが正常に動作する',
        impact: '認証モジュール',
      };

      const result = await executeFixInternal(
        THREAD_TS,
        CHANNEL_ID,
        parsed,
        'fix-login-404-error',
        executionDeps,
        USER_ID,
      );

      // 実行失敗を返すこと
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('claude_api');

      // エラーのログが出力されていること
      assertLogContains('fix_execution_error');

      // エラーメッセージがスレッドに投稿されていること
      expect(executionDeps.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: THREAD_TS,
          text: expect.stringContaining('Claude API エラー'),
        }),
      );

      // 進捗メッセージがエラーに更新されていること
      expect(executionDeps.updateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('エラー'),
        }),
      );
    });

    // -----------------------------------------------------------------------
    // 4-6: 修正実行タイムアウト
    // -----------------------------------------------------------------------
    it('修正実行がタイムアウトした場合にタイムアウトエラーが返される', async () => {
      // セッション準備
      const session: InteractiveSession = {
        threadTs: THREAD_TS,
        channelId: CHANNEL_ID,
        type: 'fix',
        phase: 'executing',
        description: 'バグ修正',
        conversationHistory: [
          { role: 'user', content: 'バグ修正' },
          { role: 'assistant', content: MOCK_ANALYSIS },
        ],
      };
      interactiveSessionManager.startSession(session);

      // runFixAgent が非常に長い時間かかるモック（タイムアウトをトリガー）
      const executionDeps = createExecutionDeps({
        runFixAgent: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 60_000)),
        ),
      });

      const parsed = {
        title: 'fix: Login 404 Error',
        analysis: 'ルーティング設定の不備',
        approach: 'ルーティングを修正する',
        acceptance: '- [ ] ログインが正常に動作する',
        impact: '認証モジュール',
      };

      // 100ms のタイムアウトで実行
      const result = await executeFixInternal(
        THREAD_TS,
        CHANNEL_ID,
        parsed,
        'fix-login-404-error',
        executionDeps,
        USER_ID,
        100, // 100ms timeout
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('timeout');

      // タイムアウトのログが出力されていること
      assertLogContains('fix_execution_error');
    });

    // -----------------------------------------------------------------------
    // 4-7: セッション不在時のスレッド返信（無視される）
    // -----------------------------------------------------------------------
    it('セッションが存在しないスレッドへの返信は無視される', async () => {
      const redraftDeps = createRedraftDeps();

      // セッションが存在しない threadTs でスレッド返信
      await handleThreadMessageInternal(
        'nonexistent.thread.ts',
        '修正依頼です',
        redraftDeps,
      );

      // 再ドラフトが呼ばれないこと
      expect(redraftDeps.generateDraft).not.toHaveBeenCalled();
      expect(redraftDeps.postMessage).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 4-8: draftingフェーズ以外のスレッド返信（無視される）
    // -----------------------------------------------------------------------
    it('executing フェーズのセッションへのスレッド返信は無視される', async () => {
      // executing フェーズのセッションを登録
      const session: InteractiveSession = {
        threadTs: THREAD_TS,
        channelId: CHANNEL_ID,
        type: 'fix',
        phase: 'executing',
        description: 'バグ修正',
        conversationHistory: [],
      };
      interactiveSessionManager.startSession(session);

      const redraftDeps = createRedraftDeps();

      await handleThreadMessageInternal(
        THREAD_TS,
        'もっと詳しく',
        redraftDeps,
      );

      // 再ドラフトが呼ばれないこと
      expect(redraftDeps.generateDraft).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 4-9: Vault 書き込みエラー
    // -----------------------------------------------------------------------
    it('Vault 書き込み失敗時にエラーメッセージがスレッドに投稿される', async () => {
      // セッション準備
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleFixInternal(['バグ'], respond, draftDeps);

      const approvalDeps = createFixApprovalDeps({
        writeFixStoryToVault: vi.fn().mockImplementation(() => {
          throw new Error('EACCES: permission denied');
        }),
      });

      await handleFixApproveInternal(THREAD_TS, MESSAGE_TS, approvalDeps, USER_ID);

      // エラーのログが出力されていること
      assertLogContains('approve_error');

      // エラーメッセージがスレッドに投稿されていること
      expect(approvalDeps.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: THREAD_TS,
          text: expect.stringContaining('失敗しました'),
        }),
      );
    });
  });

  // =========================================================================
  // ログ出力の構造検証
  // =========================================================================
  describe('ログ出力の構造検証', () => {
    it('ログにタイムスタンプ・コマンド種別・処理フェーズが含まれる', async () => {
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);

      await handleFixInternal(['テスト用バグ'], respond, draftDeps);

      // タイムスタンプ形式 [YYYY-MM-DDTHH:MM:SS.sssZ]
      const hasTimestamp = logOutput.some((line) =>
        /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\]/.test(line),
      );
      expect(hasTimestamp, 'ログにISOタイムスタンプが含まれること').toBe(true);

      // コマンド種別 cmd=fix
      const hasCommand = logOutput.some((line) => line.includes('cmd=fix'));
      expect(hasCommand, 'ログにコマンド種別 cmd=fix が含まれること').toBe(true);

      // 処理フェーズ phase=
      const hasPhase = logOutput.some((line) => line.includes('phase='));
      expect(hasPhase, 'ログに処理フェーズが含まれること').toBe(true);
    });

    it('承認フローのログにユーザーIDが含まれる', async () => {
      // セッション準備
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleFixInternal(['バグ'], respond, draftDeps);

      logOutput = []; // 承認前のログをクリア

      const approvalDeps = createFixApprovalDeps();
      await handleFixApproveInternal(THREAD_TS, MESSAGE_TS, approvalDeps, USER_ID);

      const hasUserId = logOutput.some((line) => line.includes(`user=${USER_ID}`));
      expect(hasUserId, 'ログにユーザーIDが含まれること').toBe(true);
    });

    it('スレッド返信処理のログにスレッドtsが含まれる', async () => {
      // セッション準備
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);
      await handleFixInternal(['バグ'], respond, draftDeps);

      logOutput = []; // コマンド実行のログをクリア

      const redraftDeps = createRedraftDeps();
      await handleThreadMessageInternal(THREAD_TS, '修正依頼', redraftDeps);

      const hasThreadTs = logOutput.some((line) => line.includes(`thread=${THREAD_TS}`));
      expect(hasThreadTs, 'ログにスレッドtsが含まれること').toBe(true);
    });
  });

  // =========================================================================
  // 引数バリデーション
  // =========================================================================
  describe('引数バリデーション', () => {
    it('引数なしで /ap fix を実行するとエラーメッセージが返される', async () => {
      const draftDeps = createFixDraftDeps();
      const respond = vi.fn().mockResolvedValue(undefined);

      await handleFixInternal([], respond, draftDeps);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('バグの説明を指定してください'),
      );

      // セッションが作成されないこと
      expect(interactiveSessionManager.size).toBe(0);
    });
  });
});
