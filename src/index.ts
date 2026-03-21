import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { App } from '@slack/bolt';
import { config, vaultStoriesPath } from './config';
import { readStoryFile } from './vault/reader';
import { createSlackApp } from './slack/bot';
import { registerApprovalHandlers } from './approval';
import { runStory } from './runner';

// 実行中ストーリーの重複起動防止
const runningStories = new Set<string>();

async function handleStoryFile(filePath: string, project: string, app: App): Promise<void> {
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
  runStory(story, app)
    .catch(console.error)
    .finally(() => runningStories.delete(storyId));
}

async function main(): Promise<void> {
  const slackApp = createSlackApp();
  registerApprovalHandlers(slackApp);
  await slackApp.start();
  console.log('[slack] bot started (Socket Mode)');

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
    handleStoryFile(path.resolve(filePath), project, slackApp).catch(console.error);
  });

  watcher.on('change', (filePath) => {
    handleStoryFile(path.resolve(filePath), project, slackApp).catch(console.error);
  });

  console.log('[orchestrator] ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
