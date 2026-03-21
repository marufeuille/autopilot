import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

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
  temporal: {
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'claude-workflow-kit',
  },
} as const;

export function vaultProjectPath(project: string): string {
  return path.join(config.vaultPath, 'Projects', project);
}

export function vaultTasksPath(project: string): string {
  return path.join(vaultProjectPath(project), 'tasks');
}
