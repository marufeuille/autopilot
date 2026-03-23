import { FlowSignal, TaskContext } from '../types';
import { GitSyncError, detectNoRemote } from '../../git';

/**
 * main ブランチ同期 step
 *
 * タスク実装前に main を最新化する。
 * - no-remote 検出 → 警告ログを出力してスキップ（continue）
 * - 成功 → continue
 * - GitSyncError → 通知して abort
 * - その他例外 → そのまま再 throw
 */
export async function handleSyncMain(ctx: TaskContext): Promise<FlowSignal> {
  const { story, repoPath, notifier, deps } = ctx;

  if (detectNoRemote(repoPath)) {
    console.warn('[sync-main] リモートリポジトリが見つかりません。sync-main をスキップします');
    return { kind: 'continue' };
  }

  try {
    await deps.syncMainBranch(repoPath);
    return { kind: 'continue' };
  } catch (error) {
    if (error instanceof GitSyncError) {
      await notifier.notify(
        `❌ main同期失敗: ${ctx.task.slug}\n原因: ${error.message}`,
        story.slug,
      );
      return { kind: 'abort', error };
    }
    throw error;
  }
}
