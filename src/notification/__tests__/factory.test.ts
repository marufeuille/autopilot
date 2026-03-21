import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @slack/bolt をモックして Slack バックエンド生成時にネットワーク接続しない
vi.mock('@slack/bolt', () => {
  class MockApp {
    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    action = vi.fn();
    view = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
  }
  return { App: MockApp };
});

describe('createNotificationBackend (factory)', () => {
  const originalEnv = process.env.NOTIFY_BACKEND;

  beforeEach(() => {
    // モジュールキャッシュをリセットして環境変数の変更を反映させる
    vi.resetModules();
  });

  afterEach(() => {
    // 環境変数を元に戻す
    if (originalEnv === undefined) {
      delete process.env.NOTIFY_BACKEND;
    } else {
      process.env.NOTIFY_BACKEND = originalEnv;
    }
  });

  it('NOTIFY_BACKEND=local で LocalNotificationBackend が生成される', async () => {
    process.env.NOTIFY_BACKEND = 'local';
    const { createNotificationBackend, LocalNotificationBackend } = await import('../index');

    const backend = await createNotificationBackend();

    expect(backend).toBeInstanceOf(LocalNotificationBackend);
  });

  it('環境変数未設定時のデフォルトは local', async () => {
    delete process.env.NOTIFY_BACKEND;
    const { createNotificationBackend, LocalNotificationBackend } = await import('../index');

    const backend = await createNotificationBackend();

    expect(backend).toBeInstanceOf(LocalNotificationBackend);
  });

  it('未知のバックエンド指定時に明確なエラーメッセージが出る', async () => {
    process.env.NOTIFY_BACKEND = 'unknown-backend';
    const { createNotificationBackend } = await import('../index');

    await expect(createNotificationBackend()).rejects.toThrow(
      'Unknown NOTIFY_BACKEND: "unknown-backend"',
    );
  });

  it('未知のバックエンド指定時にサポート値が案内される', async () => {
    process.env.NOTIFY_BACKEND = 'invalid';
    const { createNotificationBackend } = await import('../index');

    await expect(createNotificationBackend()).rejects.toThrow(
      /Supported values: "local".*"slack"/,
    );
  });

  it('NOTIFY_BACKEND=slack で SlackNotificationBackend が生成される', async () => {
    process.env.NOTIFY_BACKEND = 'slack';
    const { createNotificationBackend } = await import('../index');
    const { SlackNotificationBackend } = await import('../slack');

    const backend = await createNotificationBackend();

    expect(backend).toBeInstanceOf(SlackNotificationBackend);
  });

  it('生成されたバックエンドが NotificationBackend インターフェースを満たす', async () => {
    process.env.NOTIFY_BACKEND = 'local';
    const { createNotificationBackend } = await import('../index');

    const backend = await createNotificationBackend();

    // インターフェースの必須メソッドが存在する
    expect(typeof backend.notify).toBe('function');
    expect(typeof backend.requestApproval).toBe('function');
  });

  it('generateApprovalId が notification モジュールからエクスポートされている', async () => {
    const { generateApprovalId } = await import('../index');

    expect(typeof generateApprovalId).toBe('function');
    const id = generateApprovalId('story-1', 'task-1');
    expect(id).toMatch(/^story-1--task-1--\d+$/);
  });

  it('SlackNotificationBackend が notification モジュールからエクスポートされている', async () => {
    const { SlackNotificationBackend } = await import('../index');

    expect(SlackNotificationBackend).toBeDefined();
    expect(typeof SlackNotificationBackend).toBe('function');
  });
});
