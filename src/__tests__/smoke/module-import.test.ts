import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 外部I/Oのモック: chokidar（ファイルシステム監視を防止）
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    })),
  },
}));

describe('smoke: module-import', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  /** テストに影響する環境変数を退避・設定する */
  const envKeys = [
    'VAULT_PATH',
    'WATCH_PROJECT',
    'NOTIFY_BACKEND',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_CHANNEL_ID',
    'NTFY_TOPIC',
  ];

  beforeEach(() => {
    // 環境変数を退避
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }

    // Vault 用の一時ディレクトリを作成
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-import-'));
    const project = 'test-project';
    const storiesDir = path.join(tmpDir, 'Projects', project, 'stories');
    fs.mkdirSync(storiesDir, { recursive: true });

    // 外部サービスに依存する環境変数をモック
    process.env.VAULT_PATH = tmpDir;
    process.env.WATCH_PROJECT = project;
    process.env.NOTIFY_BACKEND = 'local';
    // Slack/ntfy トークンは不要だが、万が一参照されても壊れないようダミー値を設定
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_CHANNEL_ID = 'C00000000';
    process.env.NTFY_TOPIC = 'test-topic';
  });

  afterEach(() => {
    // 環境変数を復元
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }

    // 一時ディレクトリを削除
    fs.rmSync(tmpDir, { recursive: true, force: true });

    vi.restoreAllMocks();
  });

  it('src/index.ts の import が成功する', async () => {
    const mod = await import('../../index');
    expect(mod).toBeDefined();
  });

  it('notification モジュールの import が成功する', async () => {
    const mod = await import('../../notification');
    expect(mod).toBeDefined();
    expect(mod.createNotificationBackend).toBeTypeOf('function');
    expect(mod.LocalNotificationBackend).toBeTypeOf('function');
  });

  it('queue モジュールの import が成功する', async () => {
    const mod = await import('../../queue');
    expect(mod).toBeDefined();
    expect(mod.StoryQueueManager).toBeTypeOf('function');
    expect(mod.promoteNextQueuedStory).toBeTypeOf('function');
  });

  it('vault watcher（vault/reader）モジュールの import が成功する', async () => {
    const mod = await import('../../vault/reader');
    expect(mod).toBeDefined();
    expect(mod.readStoryFile).toBeTypeOf('function');
    expect(mod.readStoryBySlug).toBeTypeOf('function');
  });
});
