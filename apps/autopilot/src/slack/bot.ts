import { App } from '@slack/bolt';
import { config } from '../config';

export function createSlackApp(): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
  });
}

// ボタンハンドラは approval.ts と連携して登録する（次タスクで実装）
export function registerActionHandlers(
  _app: App,
  _onApprove: (id: string) => void,
  _onReject: (id: string) => void,
): void {
  // TODO: implemented in approval-gate task
}
