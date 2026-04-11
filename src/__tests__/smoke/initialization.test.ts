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

describe('smoke: initialization', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

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
    // モジュールキャッシュをリセットし、各テストで再初期化を検証する
    vi.resetModules();

    // 環境変数を退避
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }

    // Vault 用の一時ディレクトリを作成
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-init-'));
    const project = 'test-project';
    const storiesDir = path.join(tmpDir, 'Projects', project, 'stories');
    fs.mkdirSync(storiesDir, { recursive: true });

    // 外部サービスに依存する環境変数をモック
    process.env.VAULT_PATH = tmpDir;
    process.env.WATCH_PROJECT = project;
    process.env.NOTIFY_BACKEND = 'local';
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

  // ──────────────────────────────────
  // notification: LocalNotificationBackend の初期化
  // ──────────────────────────────────

  it('LocalNotificationBackend の初期化が完了し、主要メソッドを持つ', { timeout: 5000 }, async () => {
    const { LocalNotificationBackend } = await import('../../notification/local');
    const backend = new LocalNotificationBackend();

    expect(backend).toBeDefined();
    // NotificationBackend インターフェースの主要メソッドが存在する
    expect(backend.notify).toBeTypeOf('function');
    expect(backend.requestApproval).toBeTypeOf('function');
    expect(backend.startThread).toBeTypeOf('function');
    expect(backend.getThreadTs).toBeTypeOf('function');
    expect(backend.endSession).toBeTypeOf('function');
    expect(backend.notifyUpdate).toBeTypeOf('function');
    expect(backend.requestTaskFailureAction).toBeTypeOf('function');
    expect(backend.requestQueueFailedAction).toBeTypeOf('function');
    expect(backend.requestAcceptanceGateAction).toBeTypeOf('function');
  });

  it('createNotificationBackend(local) が正常に初期化を完了する', { timeout: 5000 }, async () => {
    const { createNotificationBackend } = await import('../../notification');
    const backend = await createNotificationBackend();

    expect(backend).toBeDefined();
    // ファクトリ経由で生成されたバックエンドも NotificationBackend インターフェースを満たす
    expect(backend.notify).toBeTypeOf('function');
    expect(backend.requestApproval).toBeTypeOf('function');
    expect(backend.startThread).toBeTypeOf('function');
    expect(backend.endSession).toBeTypeOf('function');
  });

  // ──────────────────────────────────
  // notification: ResilientNotificationBackend の初期化
  // ──────────────────────────────────

  it('ResilientNotificationBackend の初期化が完了し、主要メソッドを持つ', { timeout: 5000 }, async () => {
    const { LocalNotificationBackend } = await import('../../notification/local');
    const { ResilientNotificationBackend } = await import('../../notification/resilient');

    const inner = new LocalNotificationBackend();
    const resilient = new ResilientNotificationBackend(inner);

    expect(resilient).toBeDefined();
    expect(resilient.notify).toBeTypeOf('function');
    expect(resilient.requestApproval).toBeTypeOf('function');
    expect(resilient.startThread).toBeTypeOf('function');
    expect(resilient.endSession).toBeTypeOf('function');
    expect(resilient.notifyUpdate).toBeTypeOf('function');
    expect(resilient.requestTaskFailureAction).toBeTypeOf('function');
    expect(resilient.requestQueueFailedAction).toBeTypeOf('function');
    expect(resilient.requestAcceptanceGateAction).toBeTypeOf('function');
  });

  // ──────────────────────────────────
  // queue: StoryQueueManager の初期化
  // ──────────────────────────────────

  it('StoryQueueManager の初期化が完了し、主要メソッドを持つ', { timeout: 5000 }, async () => {
    const { StoryQueueManager } = await import('../../queue/queue-manager');

    // deps なしでもインスタンス化できる（低レベル API のみ使用時）
    const managerWithoutDeps = new StoryQueueManager();
    expect(managerWithoutDeps).toBeDefined();
    expect(managerWithoutDeps.enqueue).toBeTypeOf('function');
    expect(managerWithoutDeps.dequeue).toBeTypeOf('function');
    expect(managerWithoutDeps.peek).toBeTypeOf('function');
    expect(managerWithoutDeps.list).toBeTypeOf('function');
    expect(managerWithoutDeps.size).toBe(0);
    expect(managerWithoutDeps.isEmpty).toBe(true);

    // deps ありでもインスタンス化できる（高レベル API 使用時）
    const fakeDeps = {
      readStoryBySlug: vi.fn(),
      updateFileStatus: vi.fn(),
    };
    const managerWithDeps = new StoryQueueManager(fakeDeps);
    expect(managerWithDeps).toBeDefined();
    expect(managerWithDeps.add).toBeTypeOf('function');
    expect(managerWithDeps.cancel).toBeTypeOf('function');
    expect(managerWithDeps.shift).toBeTypeOf('function');
    expect(managerWithDeps.drain).toBeTypeOf('function');
    expect(managerWithDeps.isQueuePaused).toBe(false);
  });

  // ──────────────────────────────────
  // vault watcher: reader モジュールの初期化
  // ──────────────────────────────────

  it('vault/reader の関数が正常に初期化され、Vault ファイルを読み込める', { timeout: 5000 }, async () => {
    const { readStoryFile, readStoryBySlug } = await import('../../vault/reader');

    expect(readStoryFile).toBeTypeOf('function');
    expect(readStoryBySlug).toBeTypeOf('function');

    // 実際に一時 Vault 上のストーリーファイルを読み込めることを検証
    const storyPath = path.join(tmpDir, 'Projects', 'test-project', 'stories', 'test-story.md');
    fs.writeFileSync(storyPath, '---\nstatus: Todo\n---\n\n# Test Story\n');

    const story = readStoryFile(storyPath);
    expect(story).toBeDefined();
    expect(story.slug).toBe('test-story');
    expect(story.status).toBe('Todo');
  });

  // ──────────────────────────────────
  // 統合: notification + queue の組み合わせ初期化
  // ──────────────────────────────────

  it('notification と queue の連携初期化が完了する', { timeout: 5000 }, async () => {
    const { StoryQueueManager } = await import('../../queue/queue-manager');
    const { createNotificationBackend } = await import('../../notification');

    // main() と同じ初期化順序: queueManagers Map → notifier
    const queueManagers = new Map([
      ['test-project', new StoryQueueManager({
        readStoryBySlug: vi.fn(),
        updateFileStatus: vi.fn(),
      })],
    ]);
    const notifier = await createNotificationBackend({ queueManagers });

    expect(queueManagers.get('test-project')).toBeDefined();
    expect(notifier).toBeDefined();
    expect(queueManagers.get('test-project')!.isEmpty).toBe(true);
    expect(notifier.notify).toBeTypeOf('function');
  });

  it('notification と queue の連携初期化が後方互換（単一 queueManager）で動作する', { timeout: 5000 }, async () => {
    const { StoryQueueManager } = await import('../../queue/queue-manager');
    const { createNotificationBackend } = await import('../../notification');

    const queueManager = new StoryQueueManager({
      readStoryBySlug: vi.fn(),
      updateFileStatus: vi.fn(),
    });
    const notifier = await createNotificationBackend({ queueManager });

    expect(queueManager).toBeDefined();
    expect(notifier).toBeDefined();
    expect(queueManager.isEmpty).toBe(true);
    expect(notifier.notify).toBeTypeOf('function');
  });
});
