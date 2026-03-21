import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { config, vaultStoriesPath } from './config';
import { readStoryFile } from './vault/reader';
import { runStory } from './runner';
import { NotificationBackend, createNotificationBackend } from './notification';

// 実行中ストーリーの重複起動防止
const runningStories = new Set<string>();

async function handleStoryFile(
  filePath: string,
  project: string,
  notifier: NotificationBackend,
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
  runStory(story, notifier)
    .catch(console.error)
    .finally(() => runningStories.delete(storyId));
}

async function main(): Promise<void> {
  // ファクトリ経由で通知バックエンドを生成（環境変数 NOTIFY_BACKEND で切り替え）
  const notifier = await createNotificationBackend();
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
    handleStoryFile(path.resolve(filePath), project, notifier).catch(console.error);
  });

  watcher.on('change', (filePath) => {
    handleStoryFile(path.resolve(filePath), project, notifier).catch(console.error);
  });

  console.log('[orchestrator] ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
