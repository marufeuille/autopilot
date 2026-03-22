import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { StoryFile, TaskFile, TaskStatus, getStoryTasks } from './vault/reader';
import { updateFileStatus, createTaskFile, TaskDraft } from './vault/writer';
import { decomposeTasks } from './decomposer';
import { NotificationBackend, generateApprovalId } from './notification';
import { syncMainBranch } from './git';

function buildTaskPrompt(task: TaskFile, story: StoryFile, repoPath: string): string {
  return `あなたは優秀なソフトウェアエンジニアです。以下のタスクを実装してください。

## ストーリー: ${story.slug}
${story.content}

## タスク: ${task.slug}
${task.content}

## 作業環境
- リポジトリパス: ${repoPath}
- ブランチ名規則: feature/${task.slug}

## 重要なルール
1. 作業は必ず ${repoPath} ディレクトリ内で行うこと
2. 実装が完了したらタスクの完了条件をすべて確認すること
3. PRを作成する場合は \`gh pr create\` を実行すること
4. 実装完了後、最後に「実装完了」と出力すること

それでは実装を開始してください。`;
}

async function runClaudeAgent(prompt: string, cwd: string): Promise<void> {
  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
    },
  })) {
    if (message.type === 'assistant') {
      const content = message.message?.content ?? [];
      for (const block of content) {
        if ('text' in block && block.text) {
          process.stdout.write(`[claude] ${block.text}\n`);
        }
      }
    } else if (message.type === 'result') {
      console.log(`[runner] agent result: ${message.subtype}`);
    }
  }
}

export async function runTask(
  task: TaskFile,
  story: StoryFile,
  notifier: NotificationBackend,
  repoPath: string,
): Promise<void> {
  // タスク開始承認
  console.log(`[runner] requesting start approval: ${task.slug}`);
  const startId = generateApprovalId(story.slug, task.slug);
  const startResult = await notifier.requestApproval(
    startId,
    `*タスク開始確認*\n\n*ストーリー*: ${story.slug}\n*タスク*: ${task.slug}\n\nこのタスクを開始しますか？`,
    { approve: '開始', reject: 'スキップ' },
  );

  if (startResult.action === 'reject') {
    updateFileStatus(task.filePath, 'Skipped');
    console.log(`[runner] task skipped: ${task.slug}`);
    return;
  }

  try {
    // mainブランチを最新化してからタスクを開始する
    console.log(`[runner] syncing main branch before task: ${task.slug}`);
    await syncMainBranch(repoPath);
    console.log(`[runner] main branch synced successfully`);

    updateFileStatus(task.filePath, 'Doing');
    console.log(`[runner] task started: ${task.slug}`);

    // Claudeエージェント実行（やり直しループ）
    let prompt = buildTaskPrompt(task, story, repoPath);
    while (true) {
      await runClaudeAgent(prompt, repoPath);

      // PR URL 取得
      let prUrl = '';
      try {
        prUrl = execSync(`gh pr view feature/${task.slug} --json url -q .url`, {
          cwd: repoPath,
          encoding: 'utf-8',
        }).trim();
      } catch {
        // PR未作成の場合は無視
      }
      const prLine = prUrl ? `\n*PR*: ${prUrl}` : '';

      // タスク完了承認
      const doneId = generateApprovalId(story.slug, `${task.slug}-done`);
      const doneResult = await notifier.requestApproval(
        doneId,
        `*タスク完了確認*\n\n*タスク*: ${task.slug}${prLine}\n\n実装を確認してください。`,
        { approve: '完了', reject: 'やり直し' },
      );

      if (doneResult.action === 'approve') break;

      // やり直し: 理由をプロンプトに含めて再実行
      prompt = `前回の実装を修正してください。タスク: ${task.slug}\n\n${task.content}\n\n作業ディレクトリ: ${repoPath}\n\n## 修正依頼\n${doneResult.reason}\n\n上記の修正依頼を踏まえて、完了条件を再確認しながら修正してください。`;
      console.log(`[runner] retrying task: ${task.slug}`);
    }
  } catch (error) {
    updateFileStatus(task.filePath, 'Failed');
    console.error(`[runner] task failed: ${task.slug}`, error);
    throw error;
  }

  updateFileStatus(task.filePath, 'Done');
  console.log(`[runner] task done: ${task.slug}`);
}

function formatDecompositionMessage(story: StoryFile, drafts: TaskDraft[]): string {
  const list = drafts
    .map((d, i) => `${i + 1}. *${d.title}* (\`${d.slug}\`)\n   ${d.purpose}`)
    .join('\n');
  return `*タスク分解案*\n\n*ストーリー*: ${story.slug}\n\n${list}\n\n承認するとタスクファイルを作成して実行を開始します。`;
}

async function runDecomposition(story: StoryFile, notifier: NotificationBackend): Promise<void> {
  let retryReason: string | undefined;

  while (true) {
    console.log(`[runner] decomposing story: ${story.slug}`);
    const drafts = await decomposeTasks(story, retryReason);

    const id = generateApprovalId(story.slug, 'decompose');
    const result = await notifier.requestApproval(
      id,
      formatDecompositionMessage(story, drafts),
      { approve: '承認', reject: 'やり直し' },
    );

    if (result.action === 'approve') {
      for (const draft of drafts) {
        createTaskFile(story.project, story.slug, draft);
        console.log(`[runner] task file created: ${draft.slug}`);
      }
      return;
    }

    retryReason = result.reason;
    console.log(`[runner] decomposition rejected, retrying: ${retryReason}`);
  }
}

export async function runStory(story: StoryFile, notifier: NotificationBackend): Promise<void> {
  const repoPath = `${process.env.HOME}/dev/${story.project}`;
  console.log(`[runner] starting story: ${story.slug}`);

  const tasks = await getStoryTasks(story.project, story.slug);

  if (tasks.length === 0) {
    await runDecomposition(story, notifier);
  }

  const allCurrentTasks = await getStoryTasks(story.project, story.slug);
  const todoTasks = allCurrentTasks.filter((t) => t.status === 'Todo');

  if (todoTasks.length > 0) {
    for (const task of todoTasks) {
      try {
        await runTask(task, story, notifier, repoPath);
      } catch (error) {
        console.error(`[runner] task execution error, continuing: ${task.slug}`, error);
      }
    }
  }

  // 全タスクの最新状態を取得してストーリー完了判定
  const terminalStatuses: TaskStatus[] = ['Done', 'Skipped', 'Failed'];
  const allTasks = todoTasks.length > 0
    ? await getStoryTasks(story.project, story.slug)
    : allCurrentTasks;
  const allTerminal = allTasks.length > 0 && allTasks.every((t) => terminalStatuses.includes(t.status));
  const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === 'Done');
  if (allDone) {
    updateFileStatus(story.filePath, 'Done');
    await notifier.notify(`✅ ストーリー完了: ${story.slug}`);
    console.log(`[runner] story done: ${story.slug}`);
  } else if (allTerminal) {
    updateFileStatus(story.filePath, 'Done');
    const summary = allTasks.map((t) => `${t.slug}(${t.status})`).join(', ');
    await notifier.notify(`✅ ストーリー完了 (一部スキップ/失敗あり): ${story.slug}\n${summary}`);
    console.log(`[runner] story done with skipped/failed tasks: ${story.slug}, ${summary}`);
  } else if (todoTasks.length === 0) {
    const remaining = allTasks.filter((t) => !terminalStatuses.includes(t.status));
    console.log(
      `[runner] no todo tasks but story not complete: ${story.slug}, ` +
      `remaining: ${remaining.map((t) => `${t.slug}(${t.status})`).join(', ')}`,
    );
  } else {
    const remaining = allTasks.filter((t) => !terminalStatuses.includes(t.status));
    console.log(`[runner] story not done, remaining tasks: ${remaining.map((t) => t.slug).join(', ')}`);
  }
}
