import { execSync, execFileSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { StoryFile, TaskFile, TaskStatus, getStoryTasks } from './vault/reader';
import { updateFileStatus, createTaskFile, TaskDraft, recordTaskCompletion, TaskCompletionRecord } from './vault/writer';
import { decomposeTasks } from './decomposer';
import { syncMainBranch, createWorktree, removeWorktree } from './git';
import { runReviewLoop, ReviewLoopResult } from './review';
import { runCIPollingLoop, CIPollingResult } from './ci';

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
  updateFileStatus: (filePath: string, status: TaskStatus) => void;

  /** タスク完了を Vault に記録する */
  recordTaskCompletion: (filePath: string, record: TaskCompletionRecord) => void;

  /** git worktree を作成する */
  createWorktree: (repoPath: string, worktreePath: string, branch: string, options?: { createBranch?: boolean }) => void | Promise<void>;

  /** git worktree を削除する */
  removeWorktree: (repoPath: string, worktreePath: string) => void;
}

/**
 * デフォルトの RunnerDeps 実装を返すファクトリ関数。
 * 現行の実装（query, execSync, execFileSync 等）をそのままラップする。
 */
export function createDefaultRunnerDeps(): RunnerDeps {
  return {
    runAgent: async (prompt: string, cwd: string): Promise<void> => {
      for await (const message of query({
        prompt,
        options: {
          cwd,
          allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
          permissionMode: 'bypassPermissions',
        },
      })) {
        if (message.type === 'assistant') {
          const content = message.message?.content ?? [];
          for (const block of content) {
            if ('text' in block && block.text) {
              process.stdout.write(`[claude] ${block.text}\n`);
            }
          }
        } else if (message.type === 'result') {
          console.log(`[runner] agent result: ${message.subtype}`);
        }
      }
    },

    execGh: (args: string[], cwd: string): string => {
      console.log(`[runner-deps] execGh: gh ${args.join(' ')} (cwd=${cwd})`);
      try {
        const result = execFileSync('gh', args, {
          cwd,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        console.log(`[runner-deps] execGh success: gh ${args[0]} ${args[1] ?? ''}`);
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[runner-deps] execGh failed: gh ${args.join(' ')} — ${errorMessage}`);
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
  };
}
