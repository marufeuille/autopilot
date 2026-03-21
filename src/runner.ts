import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { App } from '@slack/bolt';
import { StoryFile, TaskFile, getStoryTasks } from './vault/reader';
import { updateFileStatus, createTaskFile, TaskDraft } from './vault/writer';
import { requestApproval, generateApprovalId } from './approval';
import { decomposeTasks } from './decomposer';
import { config } from './config';

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

async function runTask(
  task: TaskFile,
  story: StoryFile,
  app: App,
  repoPath: string,
): Promise<void> {
  // タスク開始承認
  console.log(`[runner] requesting start approval: ${task.slug}`);
  const startId = generateApprovalId(story.slug, task.slug);
  const startResult = await requestApproval(
    app,
    startId,
    `*タスク開始確認*\n\n*ストーリー*: ${story.slug}\n*タスク*: ${task.slug}\n\nこのタスクを開始しますか？`,
    { approve: '開始', reject: 'スキップ' },
  );

  if (startResult.action === 'reject') {
    console.log(`[runner] task skipped: ${task.slug}`);
    return;
  }

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
    const doneResult = await requestApproval(
      app,
      doneId,
      `*タスク完了確認*\n\n*タスク*: ${task.slug}${prLine}\n\n実装を確認してください。`,
      { approve: '完了', reject: 'やり直し' },
    );

    if (doneResult.action === 'approve') break;

    // やり直し: 理由をプロンプトに含めて再実行
    prompt = `前回の実装を修正してください。タスク: ${task.slug}\n\n${task.content}\n\n作業ディレクトリ: ${repoPath}\n\n## 修正依頼\n${doneResult.reason}\n\n上記の修正依頼を踏まえて、完了条件を再確認しながら修正してください。`;
    console.log(`[runner] retrying task: ${task.slug}`);
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

async function runDecomposition(story: StoryFile, app: App): Promise<void> {
  let retryReason: string | undefined;

  while (true) {
    console.log(`[runner] decomposing story: ${story.slug}`);
    const drafts = await decomposeTasks(story, retryReason);

    const id = generateApprovalId(story.slug, 'decompose');
    const result = await requestApproval(
      app,
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

export async function runStory(story: StoryFile, app: App): Promise<void> {
  const repoPath = `${process.env.HOME}/dev/${story.project}`;
  console.log(`[runner] starting story: ${story.slug}`);

  const tasks = await getStoryTasks(story.project, story.slug);

  if (tasks.length === 0) {
    await runDecomposition(story, app);
  }

  const todoTasks = (await getStoryTasks(story.project, story.slug)).filter(
    (t) => t.status === 'Todo',
  );

  if (todoTasks.length === 0) {
    console.log(`[runner] no todo tasks for story: ${story.slug}`);
    return;
  }

  for (const task of todoTasks) {
    await runTask(task, story, app, repoPath);
  }

  // 全タスクがDoneの場合のみストーリーを完了にする
  const allTasks = await getStoryTasks(story.project, story.slug);
  const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === 'Done');
  if (allDone) {
    updateFileStatus(story.filePath, 'Done');
    await app.client.chat.postMessage({
      channel: config.slack.channelId,
      text: `:white_check_mark: ストーリー完了: *${story.slug}*`,
    });
    console.log(`[runner] story done: ${story.slug}`);
  } else {
    const remaining = allTasks.filter((t) => t.status !== 'Done');
    console.log(`[runner] story not done, remaining tasks: ${remaining.map((t) => t.slug).join(', ')}`);
  }
}
