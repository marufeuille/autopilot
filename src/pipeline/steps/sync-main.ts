import { FlowSignal, TaskContext } from '../types';
import { GitSyncError, detectNoRemote } from '../../git';

/**
 * main ブランチ同期 step
 *
 * タスク実装前に main を最新化し、worktree を作成する。
 * - no-remote 検出 → 警告ログを出力して sync をスキップ（worktree は作成する）
 * - 成功 → continue
 * - GitSyncError → 通知して abort
 * - その他例外 → そのまま再 throw
 */
export async function handleSyncMain(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, repoPath, notifier, deps } = ctx;
  const isNoRemote = detectNoRemote(repoPath);

  if (isNoRemote) {
    console.warn('[sync-main] リモートリポジトリが見つかりません。sync-main をスキップします');
  } else {
    try {
      await deps.syncMainBranch(repoPath);
    } catch (error) {
      if (error instanceof GitSyncError) {
        await notifier.notify(
          `❌ main同期失敗: ${task.slug}\n原因: ${error.message}`,
          story.slug,
        );
        return { kind: 'abort', error };
      }
      throw error;
    }
  }

  // worktree を作成（no-remote でも作成する）
  const worktreePath = `/tmp/autopilot/${task.slug}`;
  const branch = `feature/${task.slug}`;
  try {
    deps.createWorktree(repoPath, worktreePath, branch);
    ctx.set('worktreePath', worktreePath);
  } catch (error) {
    if (error instanceof GitSyncError) {
      await notifier.notify(
        `❌ worktree作成失敗: ${task.slug}\n原因: ${error.message}`,
        story.slug,
      );
      return { kind: 'abort', error };
    }
    throw error;
  }

  return { kind: 'continue' };
}
