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

export interface ApprovalMessageParams {
  workflowId: string;
  taskSlug: string;
  project: string;
  story: string;
  filePath: string;
}

export async function sendApprovalMessage(params: ApprovalMessageParams): Promise<void> {
  const app = getApp();
  const { workflowId, taskSlug, project, story, filePath } = params;

  await app.client.chat.postMessage({
    channel: config.slack.channelId,
    text: `タスクの承認依頼: *${taskSlug}*`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*タスク承認依頼*\n\nプロジェクト: \`${project}\`\nストーリー: \`${story}\`\nタスク: \`${taskSlug}\`\nファイル: \`${filePath}\``,
        },
      },
      {
        type: 'actions',
        block_id: 'approval_actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ 承認' },
            style: 'primary',
            action_id: 'approve',
            value: workflowId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ 却下' },
            style: 'danger',
            action_id: 'reject',
            value: workflowId,
          },
        ],
      },
    ],
  });
}
