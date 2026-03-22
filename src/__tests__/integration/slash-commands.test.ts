import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';

// ---------------------------------------------------------------------------
// config をモックして FakeVault のパスを注入する
// ---------------------------------------------------------------------------
const mockConfig = {
  watchProject: 'test-project',
  vaultPath: '', // 各テストで動的に設定
};

vi.mock('../../config', () => ({
  get config() {
    return mockConfig;
  },
  vaultProjectPath: (project: string) =>
    `${mockConfig.vaultPath}/Projects/${project}`,
  vaultStoriesPath: (project: string) =>
    `${mockConfig.vaultPath}/Projects/${project}/stories`,
  vaultTasksPath: (project: string, storySlug: string) =>
    `${mockConfig.vaultPath}/Projects/${project}/tasks/${storySlug}`,
}));

// ---------------------------------------------------------------------------
// gray-matter のキャッシュ問題を回避するためモジュールをモックで包む。
// 実際のパース処理はそのまま使うが、各テストでモジュールキャッシュの影響を受けない。
// ---------------------------------------------------------------------------
vi.mock('gray-matter', async (importOriginal) => {
  const original = await importOriginal<typeof import('gray-matter')>();
  // デフォルトエクスポートをそのまま返す（キャッシュは vitest のモジュール管理で分離）
  return { ...original, default: original.default ?? original };
});

// ---------------------------------------------------------------------------
// モック設定後にインポート
// ---------------------------------------------------------------------------
import { handleStatus } from '../../slack/commands/status';
import { handleRetry } from '../../slack/commands/retry';
import {
  registerSlashCommands,
  registerSubcommand,
  clearSubcommands,
  buildHelpMessage,
  type SubcommandHandler,
} from '../../slack/slash-commands';

// ---------------------------------------------------------------------------
// Helper: ファイルの frontmatter を直接読み取る
// ---------------------------------------------------------------------------
function readFrontmatter(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { ...matter(raw).data };
}

// ---------------------------------------------------------------------------
// Slack Bolt の command ハンドラーの型
// ---------------------------------------------------------------------------
type SlackCommandHandler = (ctx: {
  command: { text: string };
  ack: (...args: unknown[]) => Promise<void>;
  respond: (msg: string) => Promise<void>;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------
describe('slash-commands integration', () => {
  let vault: FakeVaultResult;
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearSubcommands();
    respond = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vault?.cleanup();
  });

  // =========================================================================
  // /ap status
  // =========================================================================
  describe('/ap status', () => {
    it('Doing ストーリーとタスク一覧が返る', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'my-story', status: 'Doing' },
        tasks: [
          { slug: 'task-01', status: 'Done' },
          { slug: 'task-02', status: 'Doing' },
          { slug: 'task-03', status: 'Todo' },
          { slug: 'task-04', status: 'Failed' },
        ],
      });
      mockConfig.vaultPath = vault.vaultPath;

      await handleStatus([], respond);

      expect(respond).toHaveBeenCalledTimes(1);
      const msg = respond.mock.calls[0][0] as string;

      // ストーリー名が含まれる
      expect(msg).toContain('my-story');
      // タスク数が含まれる
      expect(msg).toContain('4 tasks');
      // 各タスクの slug が含まれる
      expect(msg).toContain('task-01');
      expect(msg).toContain('task-02');
      expect(msg).toContain('task-03');
      expect(msg).toContain('task-04');
      // ステータスが含まれる
      expect(msg).toContain('Done');
      expect(msg).toContain('Doing');
      expect(msg).toContain('Todo');
      expect(msg).toContain('Failed');
    });

    it('Doing ストーリーがない場合は「実行中なし」メッセージが返る', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'done-story', status: 'Done' },
        tasks: [{ slug: 'task-01', status: 'Done' }],
      });
      mockConfig.vaultPath = vault.vaultPath;

      await handleStatus([], respond);

      expect(respond).toHaveBeenCalledWith('現在実行中のストーリーはありません');
    });
  });

  // =========================================================================
  // /ap retry
  // =========================================================================
  describe('/ap retry', () => {
    it('Failed タスクのステータスが Todo に更新される', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'retry-story', status: 'Doing' },
        tasks: [
          { slug: 'ok-task', status: 'Done' },
          { slug: 'failed-task', status: 'Failed' },
        ],
      });
      mockConfig.vaultPath = vault.vaultPath;

      await handleRetry(['failed-task'], respond);

      // respond で成功メッセージが返っている
      expect(respond).toHaveBeenCalledTimes(1);
      const msg = respond.mock.calls[0][0] as string;
      expect(msg).toContain('failed-task');
      expect(msg).toContain('Todo');

      // 実際のファイルのステータスが更新されている
      const updatedFm = readFrontmatter(vault.taskFilePaths[1]);
      expect(updatedFm.status).toBe('Todo');
    });

    it('存在しないスラッグの場合はエラーメッセージが返る', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'retry-story', status: 'Doing' },
        tasks: [{ slug: 'existing-task', status: 'Failed' }],
      });
      mockConfig.vaultPath = vault.vaultPath;

      await handleRetry(['nonexistent-slug'], respond);

      expect(respond).toHaveBeenCalledTimes(1);
      const msg = respond.mock.calls[0][0] as string;
      expect(msg).toContain('見つかりませんでした');
      expect(msg).toContain('nonexistent-slug');
    });

    it('Failed 以外のステータスの場合はエラーメッセージが返る', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'retry-story', status: 'Doing' },
        tasks: [{ slug: 'doing-task', status: 'Doing' }],
      });
      mockConfig.vaultPath = vault.vaultPath;

      await handleRetry(['doing-task'], respond);

      expect(respond).toHaveBeenCalledTimes(1);
      const msg = respond.mock.calls[0][0] as string;
      expect(msg).toContain('Doing');
      expect(msg).toContain('Failed');
      expect(msg).toContain('のみ再実行できます');

      // ファイルが変更されていないことを確認
      const fm = readFrontmatter(vault.taskFilePaths[0]);
      expect(fm.status).toBe('Doing');
    });

    it('タスクスラッグ未指定時は使い方メッセージが返る', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'retry-story', status: 'Doing' },
        tasks: [],
      });
      mockConfig.vaultPath = vault.vaultPath;

      await handleRetry([], respond);

      expect(respond).toHaveBeenCalledTimes(1);
      const msg = respond.mock.calls[0][0] as string;
      expect(msg).toContain('タスクスラッグを指定してください');
    });
  });

  // =========================================================================
  // registerSlashCommands – 不明コマンドでヘルプが返る
  // =========================================================================
  describe('registerSlashCommands (app-level)', () => {
    /** mockApp から capturedHandler を取り出すヘルパー */
    function setupMockApp(): { capturedHandler: SlackCommandHandler } {
      let handler: SlackCommandHandler | undefined;
      const mockApp = {
        command: vi.fn((_name: string, h: SlackCommandHandler) => {
          handler = h;
        }),
      };
      registerSlashCommands(mockApp as any);
      expect(handler).toBeDefined();
      return { capturedHandler: handler! };
    }

    it('不明なサブコマンドでヘルプメッセージが返る', async () => {
      const { capturedHandler } = setupMockApp();

      const ack = vi.fn().mockResolvedValue(undefined);
      const respondFn = vi.fn().mockResolvedValue(undefined);

      await capturedHandler({
        command: { text: 'unknown-command' },
        ack,
        respond: respondFn,
      });

      // ack() にエラーメッセージが渡される
      expect(ack).toHaveBeenCalledTimes(1);
      const errorMsg = ack.mock.calls[0][0] as string;
      expect(errorMsg).toContain('不明なサブコマンド');
      expect(errorMsg).toContain('unknown-command');
      expect(errorMsg).toContain('/ap help');
    });

    it('空コマンドでもヘルプメッセージが返る', async () => {
      const { capturedHandler } = setupMockApp();

      const ack = vi.fn().mockResolvedValue(undefined);
      const respondFn = vi.fn().mockResolvedValue(undefined);

      await capturedHandler({
        command: { text: '' },
        ack,
        respond: respondFn,
      });

      expect(ack).toHaveBeenCalledWith(buildHelpMessage());
      // respond は呼ばれない（ack でヘルプを即時返答）
      expect(respondFn).not.toHaveBeenCalled();
    });

    it('既知のサブコマンドでは ack() 後にハンドラーが呼ばれる', async () => {
      // テスト用ハンドラーを登録
      const mockSubHandler = vi.fn().mockResolvedValue(undefined);
      registerSubcommand('status', mockSubHandler);

      const { capturedHandler } = setupMockApp();

      const ack = vi.fn().mockResolvedValue(undefined);
      const respondFn = vi.fn().mockResolvedValue(undefined);

      await capturedHandler({
        command: { text: 'status' },
        ack,
        respond: respondFn,
      });

      // ack() は引数なしで呼ばれる（即時応答）
      expect(ack).toHaveBeenCalledWith();
      // サブコマンドハンドラーが呼ばれる
      expect(mockSubHandler).toHaveBeenCalledTimes(1);
      expect(mockSubHandler).toHaveBeenCalledWith(
        [],
        expect.any(Function),
      );
    });
  });

  // =========================================================================
  // E2E: registerSlashCommands + 実際のハンドラー
  // =========================================================================
  describe('E2E: コマンドルーター → ハンドラー → Vault', () => {
    /** E2E テスト共通: 実際のハンドラーを登録して mockApp をセットアップ */
    function setupE2E(): { capturedHandler: SlackCommandHandler } {
      registerSubcommand('status', handleStatus);
      registerSubcommand('retry', handleRetry);

      let handler: SlackCommandHandler | undefined;
      const mockApp = {
        command: vi.fn((_name: string, h: SlackCommandHandler) => {
          handler = h;
        }),
      };
      registerSlashCommands(mockApp as any);
      expect(handler).toBeDefined();
      return { capturedHandler: handler! };
    }

    it('status コマンドが Vault の状態を正しく返す', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'e2e-story', status: 'Doing' },
        tasks: [
          { slug: 'e2e-task-01', status: 'Done' },
          { slug: 'e2e-task-02', status: 'Failed' },
        ],
      });
      mockConfig.vaultPath = vault.vaultPath;

      const { capturedHandler } = setupE2E();

      const ack = vi.fn().mockResolvedValue(undefined);
      const respondFn = vi.fn().mockResolvedValue(undefined);

      await capturedHandler({
        command: { text: 'status' },
        ack,
        respond: respondFn,
      });

      expect(ack).toHaveBeenCalledWith();
      expect(respondFn).toHaveBeenCalledTimes(1);
      const msg = respondFn.mock.calls[0][0] as string;
      expect(msg).toContain('e2e-story');
      expect(msg).toContain('e2e-task-01');
      expect(msg).toContain('e2e-task-02');
    });

    it('retry コマンドでタスクファイルのステータスが実際に更新される', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'e2e-story', status: 'Doing' },
        tasks: [
          { slug: 'e2e-failed-task', status: 'Failed' },
        ],
      });
      mockConfig.vaultPath = vault.vaultPath;

      const { capturedHandler } = setupE2E();

      const ack = vi.fn().mockResolvedValue(undefined);
      const respondFn = vi.fn().mockResolvedValue(undefined);

      await capturedHandler({
        command: { text: 'retry e2e-failed-task' },
        ack,
        respond: respondFn,
      });

      expect(ack).toHaveBeenCalledWith();
      expect(respondFn).toHaveBeenCalledTimes(1);
      const msg = respondFn.mock.calls[0][0] as string;
      expect(msg).toContain('e2e-failed-task');
      expect(msg).toContain('Todo');

      // ファイルが実際に更新されている
      const fm = readFrontmatter(vault.taskFilePaths[0]);
      expect(fm.status).toBe('Todo');
    });
  });
});
