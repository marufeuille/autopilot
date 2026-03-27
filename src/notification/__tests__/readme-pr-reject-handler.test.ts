import { describe, it, expect, vi, beforeEach } from 'vitest';

// config をモック（dotenv 等の外部依存を回避）
vi.mock('../../config', () => ({
  config: {
    slackChannelId: 'C_TEST',
    vaultPath: '/tmp/test-vault',
    watchProject: 'test-project',
  },
}));

import { registerReadmePRRejectHandler } from '../slack';

// execFileSync をモック
vi.mock('child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
}));

// signalRejection をモック
vi.mock('../../merge/rejection-registry', () => ({
  signalRejection: vi.fn().mockReturnValue(true),
}));

// logger をモック
vi.mock('../../logger', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { signalRejection } from '../../merge/rejection-registry';
import { logWarn, logError } from '../../logger';

/**
 * Slack App のモックを作成する
 */
function createMockApp() {
  const actionHandlers = new Map<string, Function>();

  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
      },
      views: {
        open: vi.fn().mockResolvedValue({}),
      },
    },
    action: vi.fn((actionId: string, handler: Function) => {
      actionHandlers.set(actionId, handler);
    }),
    view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    _actionHandlers: actionHandlers,
  } as any;
}

describe('registerReadmePRRejectHandler', () => {
  let mockApp: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApp = createMockApp();
    registerReadmePRRejectHandler(mockApp);
  });

  it('readme_pr_reject アクションハンドラーが登録される', () => {
    expect(mockApp.action).toHaveBeenCalledWith('readme_pr_reject', expect.any(Function));
  });

  describe('readme_pr_reject アクション（却下ボタンクリック）', () => {
    it('ack が呼ばれる', async () => {
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      const ack = vi.fn();
      await handler({
        ack,
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
        },
        respond: vi.fn().mockResolvedValue({}),
      });
      expect(ack).toHaveBeenCalled();
    });

    it('gh pr close が PR URL で実行される', async () => {
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
        },
        respond: vi.fn().mockResolvedValue({}),
      });

      expect(execFileSync).toHaveBeenCalledWith(
        'gh',
        ['pr', 'close', 'https://github.com/org/repo/pull/42'],
        { encoding: 'utf-8', stdio: 'pipe' },
      );
    });

    it('signalRejection が prUrl と "rejected" で呼び出される', async () => {
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
        },
        respond: vi.fn().mockResolvedValue({}),
      });

      expect(signalRejection).toHaveBeenCalledWith(
        'https://github.com/org/repo/pull/42',
        'rejected',
      );
    });

    it('Slack メッセージが却下済みに更新される', async () => {
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      const mockRespond = vi.fn().mockResolvedValue({});
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
        },
        respond: mockRespond,
      });

      expect(mockRespond).toHaveBeenCalledWith({
        text: '⚠️ README 更新 PR を却下しました',
        replace_original: true,
      });
    });

    it('actions が空の場合は gh pr close を実行せずに warn ログを出力する', async () => {
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      await handler({
        ack: vi.fn(),
        body: {
          actions: [],
        },
        respond: vi.fn().mockResolvedValue({}),
      });

      expect(execFileSync).not.toHaveBeenCalled();
      expect(signalRejection).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('actions が空'),
        expect.any(Object),
      );
    });

    it('action.value が空文字の場合は gh pr close を実行せずに warn ログを出力する', async () => {
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: '' }],
        },
        respond: vi.fn().mockResolvedValue({}),
      });

      expect(execFileSync).not.toHaveBeenCalled();
      expect(signalRejection).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        expect.stringContaining('actions が空'),
        expect.any(Object),
      );
    });

    it('gh pr close が失敗した場合は signalRejection を呼ばずにエラーログを出力する', async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('gh command failed');
      });
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      const mockRespond = vi.fn().mockResolvedValue({});
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
        },
        respond: mockRespond,
      });

      expect(signalRejection).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('gh pr close に失敗しました'),
        expect.objectContaining({ prUrl: 'https://github.com/org/repo/pull/42' }),
        expect.any(Error),
      );
      expect(mockRespond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('PR のクローズに失敗しました') }),
      );
    });

    it('gh pr close 失敗時に respond も失敗した場合はエラーを握り潰す', async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('gh command failed');
      });
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      const mockRespond = vi.fn().mockRejectedValue(new Error('respond failed'));
      // エラーが throw されないことを確認
      await expect(handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
        },
        respond: mockRespond,
      })).resolves.toBeUndefined();

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('gh pr close に失敗しました'),
        expect.any(Object),
        expect.any(Error),
      );
    });

    it('全体で例外が発生した場合はエラーログを出力し respond でユーザーに通知する', async () => {
      vi.mocked(signalRejection).mockImplementationOnce(() => {
        throw new Error('unexpected error');
      });
      const handler = mockApp._actionHandlers.get('readme_pr_reject');
      const mockRespond = vi.fn().mockResolvedValue({});
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
        },
        respond: mockRespond,
      });

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('却下処理に失敗しました'),
        expect.any(Object),
        expect.any(Error),
      );
      expect(mockRespond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('却下処理に失敗しました') }),
      );
    });
  });
});
