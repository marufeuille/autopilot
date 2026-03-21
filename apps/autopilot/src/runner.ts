import Anthropic from '@anthropic-ai/sdk';
import { App } from '@slack/bolt';
import { StoryFile, TaskFile, getStoryTasks } from './vault/reader';
import { updateFileStatus } from './vault/writer';
import { requestApproval, generateApprovalId } from './approval';
import { TOOL_DEFINITIONS, executeTool, ToolContext } from './tools';
import { config } from './config';

const anthropic = new Anthropic();

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
1. 実装を開始する前に run_command で \`git checkout -b feature/${task.slug}\` を実行すること
2. 実装が完了したら request_approval で人間に完了確認を求めること
3. 承認されたら update_vault_status でタスクファイルのstatusを "Done" に更新すること
4. PRを作成する場合は run_command で \`gh pr create\` を実行すること
5. タスクの完了条件をすべて満たしてから request_approval を呼ぶこと

それでは実装を開始してください。`;
}

async function runTask(
  task: TaskFile,
  story: StoryFile,
  app: App,
  repoPath: string,
): Promise<void> {
  const approvalId = generateApprovalId(story.slug, task.slug);

  // タスク開始承認
  console.log(`[runner] requesting start approval: ${task.slug}`);
  const startResult = await requestApproval(
    app,
    approvalId,
    `*タスク開始確認*\n\n*ストーリー*: ${story.slug}\n*タスク*: ${task.slug}\n\nこのタスクを開始しますか？`,
    { approve: '開始', reject: 'スキップ' },
  );

  if (startResult === 'reject') {
    console.log(`[runner] task skipped: ${task.slug}`);
    return;
  }

  // Vault: Doing に更新
  updateFileStatus(task.filePath, 'Doing');
  console.log(`[runner] task started: ${task.slug}`);

  // Claudeエージェントループ
  const ctx: ToolContext = {
    app,
    repoPath,
    storySlug: story.slug,
    taskSlug: task.slug,
  };

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildTaskPrompt(task, story, repoPath) },
  ];

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    console.log(`[runner] claude stop_reason: ${response.stop_reason}`);

    // ツール呼び出しを処理
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUseBlocks.length > 0) {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`[runner] tool: ${toolUse.name}`);
        const result = await executeTool(
          toolUse.name,
          toolUse.input as Record<string, string>,
          ctx,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    } else {
      // end_turn またはツールなし → ループ終了
      break;
    }
  }

  console.log(`[runner] task completed: ${task.slug}`);
}

export async function runStory(story: StoryFile, app: App): Promise<void> {
  const repoPath = `${process.env.HOME}/dev/${story.project}`;
  console.log(`[runner] starting story: ${story.slug}`);

  const tasks = await getStoryTasks(story.project, story.slug);
  const todoTasks = tasks.filter((t) => t.status === 'Todo');

  if (todoTasks.length === 0) {
    console.log(`[runner] no todo tasks for story: ${story.slug}`);
    return;
  }

  for (const task of todoTasks) {
    await runTask(task, story, app, repoPath);
  }

  // ストーリー完了
  updateFileStatus(story.filePath, 'Done');
  await app.client.chat.postMessage({
    channel: config.slack.channelId,
    text: `:white_check_mark: ストーリー完了: *${story.slug}*`,
  });
  console.log(`[runner] story done: ${story.slug}`);
}
