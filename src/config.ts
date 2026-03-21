import * as dotenv from 'dotenv';
import * as path from 'path';

// .env をリポジトリルートから読む（src/ → .. がルート）
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  vaultPath: required('VAULT_PATH'),
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    channelId: required('SLACK_CHANNEL_ID'),
  },
  watchProjects: (process.env.WATCH_PROJECTS ?? 'claude-workflow-kit')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
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
