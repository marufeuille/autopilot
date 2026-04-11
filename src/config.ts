import * as dotenv from 'dotenv';
import * as path from 'path';

// .env をリポジトリルートから読む（src/ → .. がルート）
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

// ─── AgentBackend 設定 ───────────────────────────────────

/** バックエンド種別（現時点では 'claude' のみ） */
export type AgentBackendType = 'claude';

/** step ごとのバックエンド設定 */
export interface AgentBackendConfig {
  type: AgentBackendType;
}

/** step 名の一覧 */
export type AgentStepName = 'implementation' | 'review' | 'planning' | 'fix';

/** 全 step のバックエンド設定マップ */
export type AgentBackendsConfig = Record<AgentStepName, AgentBackendConfig>;

const DEFAULT_AGENT_BACKEND: AgentBackendConfig = { type: 'claude' };

const DEFAULT_AGENT_BACKENDS: AgentBackendsConfig = {
  implementation: { ...DEFAULT_AGENT_BACKEND },
  review:         { ...DEFAULT_AGENT_BACKEND },
  planning:       { ...DEFAULT_AGENT_BACKEND },
  fix:            { ...DEFAULT_AGENT_BACKEND },
};

const VALID_BACKEND_TYPES: readonly AgentBackendType[] = ['claude'];
const REQUIRED_STEPS: readonly AgentStepName[] = ['implementation', 'review', 'planning', 'fix'];

/**
 * agentBackends 設定をバリデーションし、正規化して返す。
 * 未指定時はデフォルト値にフォールバックする。
 */
export function validateAgentBackends(
  input: unknown,
): AgentBackendsConfig {
  if (input === undefined || input === null) {
    return { ...DEFAULT_AGENT_BACKENDS };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('agentBackends must be an object');
  }

  const raw = input as Record<string, unknown>;
  const result = { ...DEFAULT_AGENT_BACKENDS };

  // 未知の step 名を検出
  for (const key of Object.keys(raw)) {
    if (!REQUIRED_STEPS.includes(key as AgentStepName)) {
      throw new Error(`Unknown agent step: '${key}'. Valid steps: ${REQUIRED_STEPS.join(', ')}`);
    }
  }

  for (const stepName of REQUIRED_STEPS) {
    const stepConfig = raw[stepName];
    if (stepConfig === undefined) {
      // 未指定の step はデフォルト値
      continue;
    }

    if (typeof stepConfig !== 'object' || stepConfig === null || Array.isArray(stepConfig)) {
      throw new Error(`agentBackends.${stepName} must be an object`);
    }

    const { type } = stepConfig as Record<string, unknown>;
    if (type === undefined) {
      throw new Error(`agentBackends.${stepName}.type is required`);
    }
    if (typeof type !== 'string' || !VALID_BACKEND_TYPES.includes(type as AgentBackendType)) {
      throw new Error(
        `agentBackends.${stepName}.type must be one of: ${VALID_BACKEND_TYPES.join(', ')}. Got: '${type}'`,
      );
    }

    result[stepName] = { type: type as AgentBackendType };
  }

  return result;
}

/** 通知バックエンド種別。"local" | "slack" | "ntfy"（デフォルト: "local"） */
export const notifyBackend = (process.env.NOTIFY_BACKEND ?? 'local') as 'local' | 'slack' | 'ntfy';

export const config = {
  /** Vault パス（遅延評価: 実際にアクセスされたときのみ環境変数を検証する） */
  get vaultPath(): string {
    return required('VAULT_PATH');
  },
  /** step ごとのエージェントバックエンド設定（デフォルト: 全 step が claude） */
  agentBackends: { ...DEFAULT_AGENT_BACKENDS } as AgentBackendsConfig,
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
  /** カンマ区切りで複数プロジェクトを指定可能（例: WATCH_PROJECT=stash,hoge） */
  watchProjects: (process.env.WATCH_PROJECT ?? 'claude-workflow-kit')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
  /** 後方互換: watchProjects[0] を返す getter */
  get watchProject(): string {
    return this.watchProjects[0];
  },
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
