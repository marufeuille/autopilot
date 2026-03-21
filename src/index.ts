import * as path from 'path';
import * as fs from 'fs';
import chokidar from 'chokidar';
import { Client, Connection } from '@temporalio/client';
import { setSlackApp } from './activities/slack';
import { createSlackApp, registerApprovalHandlers } from './slack/bot';
import { createWorker } from './worker';
import { getPendingApprovalTasks } from './vault/reader';
import { taskWorkflow } from './workflows/task-workflow';
import { config, vaultTasksPath } from './config';

async function startWorkflowForTask(
  temporalClient: Client,
  filePath: string,
  project: string,
): Promise<void> {
  const taskSlug = path.basename(filePath, '.md');

  // 既に実行中の Workflow があればスキップ
  try {
    const handle = temporalClient.workflow.getHandle(taskSlug);
    await handle.describe();
    console.log(`[orchestrator] workflow already running for ${taskSlug}, skipping`);
    return;
  } catch {
    // not found → start new workflow
  }

  const tasks = await getPendingApprovalTasks(project);
  // path.resolve で正規化して比較
  const task = tasks.find((t) => path.resolve(t.filePath) === path.resolve(filePath));
  if (!task) {
    console.log(`[orchestrator] ${taskSlug} not pending_approval, skipping`);
    return;
  }

  console.log(`[orchestrator] starting workflow for ${taskSlug}`);
  await temporalClient.workflow.start(taskWorkflow, {
    taskQueue: config.temporal.taskQueue,
    workflowId: taskSlug,
    args: [{ filePath: task.filePath, project, taskSlug, story: task.story }],
  });
  console.log(`[orchestrator] workflow started: ${taskSlug}`);
}

async function handleFileEvent(
  temporalClient: Client,
  filePath: string,
  project: string,
  event: 'add' | 'change',
): Promise<void> {
  if (!filePath.endsWith('.md') || filePath.endsWith('README.md')) return;
  console.log(`[vault] ${event}: ${path.basename(filePath)}`);
  await startWorkflowForTask(temporalClient, filePath, project);
}

async function main(): Promise<void> {
  // Temporal 接続
  const connection = await Connection.connect({ address: config.temporal.address });
  const temporalClient = new Client({ connection });

  // Slack アプリ初期化
  const slackApp = createSlackApp();
  setSlackApp(slackApp);
  registerApprovalHandlers(slackApp, temporalClient);

  // Temporal Worker 起動
  const worker = await createWorker();
  worker.run().catch(console.error);

  // Slack Bot 起動
  await slackApp.start();
  console.log('[slack] bot started (Socket Mode)');

  // WATCH_PROJECTS: カンマ区切りで複数指定可（例: claude-workflow-kit,cwk-test）
  const projects = (process.env.WATCH_PROJECTS ?? 'claude-workflow-kit')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  for (const project of projects) {
    const watchPath = vaultTasksPath(project);

    if (!fs.existsSync(watchPath)) {
      console.warn(`[vault] tasks dir not found, skipping: ${watchPath}`);
      continue;
    }

    console.log(`[vault] watching ${watchPath}`);

    // ディレクトリを直接 watch（glob パターンは使わない）
    const watcher = chokidar.watch(watchPath, {
      ignoreInitial: false,
      depth: 5,
    });

    watcher.on('add', (filePath) => {
      handleFileEvent(temporalClient, filePath, project, 'add').catch(console.error);
    });

    watcher.on('change', (filePath) => {
      handleFileEvent(temporalClient, filePath, project, 'change').catch(console.error);
    });
  }

  console.log('[orchestrator] ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
