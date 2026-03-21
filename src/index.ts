import * as path from 'path';
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
  const task = tasks.find((t) => t.filePath === filePath);
  if (!task) return;

  console.log(`[orchestrator] starting workflow for ${taskSlug}`);
  await temporalClient.workflow.start(taskWorkflow, {
    taskQueue: config.temporal.taskQueue,
    workflowId: taskSlug,
    args: [{ filePath, project, taskSlug, story: task.story }],
  });
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

  // Vault 監視：起動時に既存の pending_approval タスクを処理
  // WATCH_PROJECTS: カンマ区切りで複数指定可（例: claude-workflow-kit,cwk-test）
  const projects = (process.env.WATCH_PROJECTS ?? 'claude-workflow-kit').split(',').map((p) => p.trim());

  for (const project of projects) {
    const watchPath = vaultTasksPath(project);
  console.log(`[vault] watching ${watchPath}`);

    console.log(`[vault] watching ${watchPath}`);
    const watcher = chokidar.watch(path.join(watchPath, '**', '*.md'), {
      ignoreInitial: false,
      ignored: /README\.md$/,
    });

    watcher.on('add', async (filePath) => {
      const tasks = await getPendingApprovalTasks(project);
      if (tasks.some((t) => t.filePath === filePath)) {
        await startWorkflowForTask(temporalClient, filePath, project).catch(console.error);
      }
    });

    watcher.on('change', async (filePath) => {
      const tasks = await getPendingApprovalTasks(project);
      if (tasks.some((t) => t.filePath === filePath)) {
        await startWorkflowForTask(temporalClient, filePath, project).catch(console.error);
      }
    });
  }

  console.log('[orchestrator] ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
