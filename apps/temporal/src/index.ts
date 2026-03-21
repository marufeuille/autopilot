import * as path from 'path';
import * as fs from 'fs';
import chokidar from 'chokidar';
import { Client, Connection } from '@temporalio/client';
import { setSlackApp } from './activities/slack';
import { createSlackApp, registerApprovalHandlers } from './slack/bot';
import { createWorker } from './worker';
import { readStoryFile } from './vault/reader';
import { storyWorkflow } from './workflows/story-workflow';
import { config } from './config';

function vaultStoriesPath(project: string): string {
  return path.join(config.vaultPath, 'Projects', project, 'stories');
}

async function startStoryWorkflow(
  temporalClient: Client,
  filePath: string,
  project: string,
): Promise<void> {
  if (!filePath.endsWith('.md')) return;

  const story = readStoryFile(filePath);
  if (story.status !== 'Doing') return;

  const workflowId = `story--${story.slug}`;

  // 既に実行中なら skip
  try {
    const desc = await temporalClient.workflow.getHandle(workflowId).describe();
    if (desc.status.name === 'RUNNING') {
      console.log(`[orchestrator] story workflow already running: ${story.slug}`);
      return;
    }
  } catch {
    // not found → proceed
  }

  console.log(`[orchestrator] starting story workflow: ${story.slug}`);
  await temporalClient.workflow.start(storyWorkflow, {
    taskQueue: config.temporal.taskQueue,
    workflowId,
    args: [{ story, project }],
  });
  console.log(`[orchestrator] story workflow started: ${workflowId}`);
}

async function main(): Promise<void> {
  const connection = await Connection.connect({ address: config.temporal.address });
  const temporalClient = new Client({ connection });

  const slackApp = createSlackApp();
  setSlackApp(slackApp);
  registerApprovalHandlers(slackApp, temporalClient);

  const worker = await createWorker();
  worker.run().catch(console.error);

  await slackApp.start();
  console.log('[slack] bot started (Socket Mode)');

  // WATCH_PROJECTS: カンマ区切りで複数指定可
  const projects = (process.env.WATCH_PROJECTS ?? 'claude-workflow-kit')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const project of projects) {
    const storiesPath = vaultStoriesPath(project);

    if (!fs.existsSync(storiesPath)) {
      console.warn(`[vault] stories dir not found, skipping: ${storiesPath}`);
      continue;
    }

    console.log(`[vault] watching stories: ${storiesPath}`);

    const watcher = chokidar.watch(storiesPath, {
      ignoreInitial: false,
      depth: 1,
    });

    watcher.on('add', (filePath) => {
      startStoryWorkflow(temporalClient, filePath, project).catch(console.error);
    });

    watcher.on('change', (filePath) => {
      startStoryWorkflow(temporalClient, filePath, project).catch(console.error);
    });
  }

  console.log('[orchestrator] ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
