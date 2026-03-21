import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import { config, vaultStoriesPath } from './config';
import { readStoryFile } from './vault/reader';
import { createSlackApp } from './slack/bot';

// 実行中ストーリーの重複起動防止
const runningStories = new Set<string>();

async function handleStoryFile(filePath: string, project: string): Promise<void> {
  if (!filePath.endsWith('.md')) return;

  const story = readStoryFile(filePath);
  if (story.status !== 'Doing') return;

  const storyId = `${project}--${story.slug}`;
  if (runningStories.has(storyId)) {
    console.log(`[orchestrator] already running: ${storyId}`);
    return;
  }

  console.log(`[orchestrator] story detected: ${storyId}`);
  // TODO: runStory(story, project) — implemented in agent-runner task
}

async function main(): Promise<void> {
  const slackApp = createSlackApp();
  await slackApp.start();
  console.log('[slack] bot started (Socket Mode)');

  for (const project of config.watchProjects) {
    const storiesPath = vaultStoriesPath(project);

    if (!fs.existsSync(storiesPath)) {
      console.warn(`[vault] stories dir not found, skipping: ${storiesPath}`);
      continue;
    }

    console.log(`[vault] watching: ${storiesPath}`);

    const watcher = chokidar.watch(storiesPath, {
      ignoreInitial: false,
      depth: 1,
    });

    watcher.on('add', (filePath) => {
      handleStoryFile(path.resolve(filePath), project).catch(console.error);
    });

    watcher.on('change', (filePath) => {
      handleStoryFile(path.resolve(filePath), project).catch(console.error);
    });
  }

  console.log('[orchestrator] ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
