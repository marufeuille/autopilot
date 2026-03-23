import path from 'path';
import { FlowSignal, TaskContext } from '../types';
import { GitSyncError, detectNoRemote } from '../../git';

/**
 * worktree のベースディレクトリ。
 * テスタビリティと環境ごとの柔軟性のために定数として外出し。
 */
export const WORKTREE_BASE_DIR = '/tmp/autopilot';

/**
 * slug に含まれるパストラバーサル文字を除去し、安全なディレクトリ名を返す。
 * 許可する文字: 英数字、ハイフン、アンダースコア、ドット
 */
export function sanitizeSlug(slug: string): string {
  // パス区切りを除去し、安全な文字のみ残す
  const sanitized = path.basename(slug).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`Invalid slug: "${slug}"`);
  }
  return sanitized;
}

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
  const safeSlug = sanitizeSlug(task.slug);
  const worktreePath = path.join(WORKTREE_BASE_DIR, safeSlug);
  const branch = `feature/${safeSlug}`;
  try {
    await deps.createWorktree(repoPath, worktreePath, branch);
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
