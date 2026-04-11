import { execSync, execFileSync } from 'child_process';
import { StoryFile, StoryStatus, TaskFile, TaskStatus, getStoryTasks } from './vault/reader';
import { updateFileStatus, createTaskFile, TaskDraft, recordTaskCompletion, TaskCompletionRecord } from './vault/writer';
import { decomposeTasks } from './decomposer';
import { syncMainBranch, createWorktree, removeWorktree } from './git';
import { runReviewLoop, ReviewLoopResult } from './review';
import { runCIPollingLoop, CIPollingResult } from './ci';
import { checkAcceptanceCriteria, AcceptanceCheckResult, AcceptanceGateDeps, CriterionResult, generateAdditionalTasks, AdditionalTasksDeps, defaultQueryAI } from './story-acceptance-gate';
import { createCommandLogger } from './logger';
import { createBackend } from './agent/backend';
import { config } from './config';

const depsLog = createCommandLogger('runner-deps');

/**
 * runner の外部依存を表すインターフェース。
 * テスト時に差し替え可能にするために抽出。
 */
export interface RunnerDeps {
  /** Claude エージェントを実行する */
  runAgent: (prompt: string, cwd: string) => Promise<void>;

  /** gh CLI コマンドを実行する (execFileSync 相当) */
  execGh: (args: string[], cwd: string) => string;

  /** 任意のシェルコマンドを実行する (execSync 相当、git push や gh pr create 等) */
  execCommand: (command: string, cwd: string) => string;

  /** セルフレビューループを実行する */
  runReviewLoop: (repoPath: string, branch: string, taskContent: string) => Promise<ReviewLoopResult>;

  /** CI ポーリングループを実行する */
  runCIPollingLoop: (repoPath: string, branch: string, taskContent: string) => Promise<CIPollingResult>;

  /** ストーリーをタスクに分解する */
  decomposeTasks: (story: StoryFile, retryReason?: string) => Promise<TaskDraft[]>;

  /** タスクファイルを作成する */
  createTaskFile: (project: string, storySlug: string, draft: TaskDraft) => void;

  /** main ブランチを最新化する */
  syncMainBranch: (repoPath: string) => Promise<void>;

  /** ストーリーに属するタスク一覧を取得する */
  getStoryTasks: (project: string, storySlug: string) => Promise<TaskFile[]>;

  /** ファイルのステータスを更新する */
  updateFileStatus: (filePath: string, status: TaskStatus | StoryStatus) => void;

  /** タスク完了を Vault に記録する */
  recordTaskCompletion: (filePath: string, record: TaskCompletionRecord) => void;

  /** git worktree を作成する */
  createWorktree: (repoPath: string, worktreePath: string, branch: string, options?: { createBranch?: boolean }) => void | Promise<void>;

  /** git worktree を削除する */
  removeWorktree: (repoPath: string, worktreePath: string) => void;

  /** ストーリーの受け入れ条件をチェックする */
  checkAcceptanceCriteria: (story: StoryFile, tasks: TaskFile[], repoPath: string) => Promise<AcceptanceCheckResult>;

  /** ユーザーコメントから追加タスク案を生成する */
  generateAdditionalTasks: (story: StoryFile, existingTasks: TaskFile[], comment: string, failedCriteria: CriterionResult[]) => Promise<TaskDraft[]>;
}

/**
 * デフォルトの RunnerDeps 実装を返すファクトリ関数。
 * 現行の実装（query, execSync, execFileSync 等）をそのままラップする。
 */
export function createDefaultRunnerDeps(): RunnerDeps {
  const backend = createBackend(config.agentBackends.implementation);

  return {
    runAgent: async (prompt: string, cwd: string): Promise<void> => {
      await backend.run(prompt, { cwd });
    },

    execGh: (args: string[], cwd: string): string => {
      depsLog.info('execGh', { command: `gh ${args.join(' ')}`, cwd, phase: 'exec' });
      try {
        const result = execFileSync('gh', args, {
          cwd,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        depsLog.info('execGh success', { command: `gh ${args[0]} ${args[1] ?? ''}`, phase: 'exec' });
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        depsLog.error('execGh failed', { command: `gh ${args.join(' ')}`, errorMessage, phase: 'exec' });
        throw error;
      }
    },

    execCommand: (command: string, cwd: string): string => {
      return execSync(command, {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    },

    runReviewLoop,
    runCIPollingLoop,
    decomposeTasks,
    createTaskFile,
    syncMainBranch,
    getStoryTasks,
    updateFileStatus,
    recordTaskCompletion,
    createWorktree,
    removeWorktree,
    checkAcceptanceCriteria: (story: StoryFile, tasks: TaskFile[], repoPath: string) => {
      const gateDeps: AcceptanceGateDeps = {
        execGh: (args: string[], cwd: string) => {
          return execFileSync('gh', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
        },
        queryAI: defaultQueryAI,
      };
      return checkAcceptanceCriteria(story, tasks, repoPath, gateDeps);
    },
    generateAdditionalTasks: (story: StoryFile, existingTasks: TaskFile[], comment: string, failedCriteria: CriterionResult[]) => {
      const additionalDeps: AdditionalTasksDeps = {
        queryAI: defaultQueryAI,
      };
      return generateAdditionalTasks(story, existingTasks, comment, failedCriteria, additionalDeps);
    },
  };
}
