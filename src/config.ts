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
  /** Vault パス（遅延評価: 実際にアクセスされたときのみ環境変数を検証する） */
  get vaultPath(): string {
    return required('VAULT_PATH');
  },
  /** Slack 設定は notifyBackend === 'slack' のときだけ必須（遅延評価） */
  slack: {
    get botToken(): string {
      return notifyBackend === 'slack' ? required('SLACK_BOT_TOKEN') : (process.env.SLACK_BOT_TOKEN ?? '');
    },
    get appToken(): string {
      return notifyBackend === 'slack' ? required('SLACK_APP_TOKEN') : (process.env.SLACK_APP_TOKEN ?? '');
    },
    get channelId(): string {
      return notifyBackend === 'slack' ? required('SLACK_CHANNEL_ID') : (process.env.SLACK_CHANNEL_ID ?? '');
    },
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
};

/**
 * repoPath の解決。
 * 優先順位: REPO_BASE_PATH > ${HOME}/dev > エラー
 */
export function resolveRepoPath(project: string): string {
  const repoBasePath = process.env.REPO_BASE_PATH;
  if (repoBasePath) {
    return path.join(repoBasePath, project);
  }
  const home = process.env.HOME;
  if (home) {
    return path.join(home, 'dev', project);
  }
  throw new Error(
    'Cannot resolve repo path: neither REPO_BASE_PATH nor HOME environment variable is set. ' +
    'Please set REPO_BASE_PATH to specify the base directory for repositories.',
  );
}

export function vaultProjectPath(project: string): string {
  return path.join(config.vaultPath, 'Projects', project);
}

export function vaultStoriesPath(project: string): string {
  return path.join(vaultProjectPath(project), 'stories');
}

export function vaultTasksPath(project: string, storySlug: string): string {
  return path.join(vaultProjectPath(project), 'tasks', storySlug);
}
