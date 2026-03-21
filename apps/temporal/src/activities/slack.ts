import { App } from '@slack/bolt';
import { config } from '../config';

let _app: App | null = null;

export function setSlackApp(app: App): void {
  _app = app;
}

function getApp(): App {
  if (!_app) throw new Error('Slack app not initialized. Call setSlackApp() first.');
  return _app;
}

async function post(text: string, blocks: unknown[]): Promise<void> {
  await getApp().client.chat.postMessage({
    channel: config.slack.channelId,
    text,
    blocks: blocks as any,
  });
}

export interface TaskStartParams {
  workflowId: string;
  taskSlug: string;
  storySlug: string;
  project: string;
}

export async function sendTaskStartApproval(params: TaskStartParams): Promise<void> {
  const { workflowId, taskSlug, storySlug, project } = params;
  await post(`タスク開始の承認依頼: *${taskSlug}*`, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*タスク開始を承認してください*\n\nプロジェクト: \`${project}\`\nストーリー: \`${storySlug}\`\nタスク: \`${taskSlug}\``,
      },
    },
    {
      type: 'actions',
      block_id: 'task_start_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '▶️ 開始' },
          style: 'primary',
          action_id: 'task_start_approve',
          value: workflowId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⏭️ スキップ' },
          action_id: 'task_start_skip',
          value: workflowId,
        },
      ],
    },
  ]);
}

export interface TaskDoneParams {
  workflowId: string;
  taskSlug: string;
  storySlug: string;
  project: string;
}

export async function sendTaskDoneApproval(params: TaskDoneParams): Promise<void> {
  const { workflowId, taskSlug, storySlug, project } = params;
  await post(`タスク完了の確認: *${taskSlug}*`, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*タスク完了を確認してください*\n\nプロジェクト: \`${project}\`\nストーリー: \`${storySlug}\`\nタスク: \`${taskSlug}\``,
      },
    },
    {
      type: 'actions',
      block_id: 'task_done_actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ 完了' },
          style: 'primary',
          action_id: 'task_done_approve',
          value: workflowId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔁 やり直し' },
          style: 'danger',
          action_id: 'task_done_reject',
          value: workflowId,
        },
      ],
    },
  ]);
}

export async function sendStoryDoneNotification(
  storySlug: string,
  project: string,
): Promise<void> {
  await post(`🎉 ストーリー完了: *${storySlug}*`, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*ストーリーが完了しました* 🎉\n\nプロジェクト: \`${project}\`\nストーリー: \`${storySlug}\``,
      },
    },
  ]);
}
