import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { config, vaultStoriesPath } from './config';
import { readStoryFile, readStoryBySlug } from './vault/reader';
import { updateFileStatus } from './vault/writer';
import { runStory } from './runner';
import { NotificationBackend, createNotificationBackend } from './notification';
import { StoryQueueManager } from './queue/queue-manager';
import { promoteNextQueuedStory } from './queue/auto-promote';
import { initTelemetry, shutdownTelemetry, TelemetryHandle } from './telemetry';

// 実行中ストーリーの重複起動防止
const runningStories = new Set<string>();

// OTel ハンドル（module スコープで保持し SIGINT ハンドラからアクセス可能にする）
let telemetry: TelemetryHandle | undefined;

async function handleStoryFile(
  filePath: string,
  project: string,
  notifier: NotificationBackend,
  queueManager: StoryQueueManager,
): Promise<void> {
  if (!filePath.endsWith('.md')) return;

  const story = readStoryFile(filePath);
  if (story.status !== 'Doing') return;

  const storyId = `${project}--${story.slug}`;
  if (runningStories.has(storyId)) {
    console.log(`[orchestrator] already running: ${storyId}`);
    return;
  }

  console.log(`[orchestrator] story detected: ${storyId}`);
  runningStories.add(storyId);

  try {
    const finalStatus = await runStory(story, notifier);

    // Story 完了後にキュー先頭を自動プロモート
    await promoteNextQueuedStory(
      finalStatus,
      story,
      queueManager,
      notifier,
      { updateFileStatus, runStory },
    );
  } catch (error) {
    console.error(error);
  } finally {
    runningStories.delete(storyId);
  }
}

async function main(): Promise<void> {
  // OTel 初期化（OTEL_ENABLED=true の場合のみトレース送信）
  telemetry = initTelemetry();

  try {
    // キューマネージャーを生成（全バックエンドで共有）
    const queueManager = new StoryQueueManager({ readStoryBySlug, updateFileStatus });

    // ファクトリ経由で通知バックエンドを生成（環境変数 NOTIFY_BACKEND で切り替え）
    // Slack バックエンドの場合、共有 QueueManager を Slack コマンドにも渡す
    const notifier = await createNotificationBackend({ queueManager });
    const backendType = process.env.NOTIFY_BACKEND ?? 'local';
    console.log(`[notification] backend started: ${backendType}`);

    const project = config.watchProject;
    const storiesPath = vaultStoriesPath(project);

    if (!fs.existsSync(storiesPath)) {
      throw new Error(`[vault] stories dir not found: ${storiesPath}`);
    }

    console.log(`[vault] watching: ${storiesPath}`);

    const watcher = chokidar.watch(storiesPath, {
      ignoreInitial: false,
      depth: 1,
    });

    watcher.on('add', (filePath) => {
      handleStoryFile(path.resolve(filePath), project, notifier, queueManager).catch(console.error);
    });

    watcher.on('change', (filePath) => {
      handleStoryFile(path.resolve(filePath), project, notifier, queueManager).catch(console.error);
    });

    console.log('[orchestrator] ready');
  } catch (err) {
    // 初期化失敗時もバッファをフラッシュしてからスパンを失わない
    await shutdownTelemetry(telemetry);
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Graceful shutdown: プロセス終了時に OTel バッファをフラッシュ
process.on('SIGINT', async () => {
  if (telemetry) {
    await shutdownTelemetry(telemetry);
  }
  process.exit(0);
});
