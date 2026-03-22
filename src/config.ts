import * as dotenv from 'dotenv';
import * as path from 'path';

// .env をリポジトリルートから読む（src/ → .. がルート）
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/** 通知バックエンド種別。"local" | "slack" | "ntfy"（デフォルト: "local"） */
export const notifyBackend = (process.env.NOTIFY_BACKEND ?? 'local') as 'local' | 'slack' | 'ntfy';

export const config = {
  vaultPath: required('VAULT_PATH'),
  /** Slack 設定は notifyBackend === 'slack' のときだけ必須 */
  slack: notifyBackend === 'slack'
    ? {
        botToken: required('SLACK_BOT_TOKEN'),
        appToken: required('SLACK_APP_TOKEN'),
        channelId: required('SLACK_CHANNEL_ID'),
      }
    : {
        botToken: process.env.SLACK_BOT_TOKEN ?? '',
        appToken: process.env.SLACK_APP_TOKEN ?? '',
        channelId: process.env.SLACK_CHANNEL_ID ?? '',
      },
  /** ntfy 設定は notifyBackend === 'ntfy' のときだけ必須 */
  ntfy: notifyBackend === 'ntfy'
    ? {
        topic: required('NTFY_TOPIC'),
        serverUrl: process.env.NTFY_SERVER_URL ?? 'https://ntfy.sh',
        callbackBaseUrl: process.env.NTFY_CALLBACK_BASE_URL ?? '',
      }
    : {
        topic: process.env.NTFY_TOPIC ?? '',
        serverUrl: process.env.NTFY_SERVER_URL ?? 'https://ntfy.sh',
        callbackBaseUrl: process.env.NTFY_CALLBACK_BASE_URL ?? '',
      },
  watchProject: process.env.WATCH_PROJECT ?? 'claude-workflow-kit',
} as const;

export function vaultProjectPath(project: string): string {
  return path.join(config.vaultPath, 'Projects', project);
}

export function vaultStoriesPath(project: string): string {
  return path.join(vaultProjectPath(project), 'stories');
}

export function vaultTasksPath(project: string, storySlug: string): string {
  return path.join(vaultProjectPath(project), 'tasks', storySlug);
}
