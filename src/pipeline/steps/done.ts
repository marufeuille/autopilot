import { FlowSignal, TaskContext } from '../types';

/**
 * タスク完了 step
 *
 * ファイルステータスを Done に更新し、Vault に完了レコードを記録し、完了通知を送る。
 * ローカルオンリーモード時は mode: 'local-only'、prUrl: null、localCommitSha を記録する。
 * worktreePath が設定されている場合は worktree をクリーンアップする。
 * 常に continue を返す（pipelineが終端に達し 'done' になる）。
 */
export async function handleDone(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, notifier, deps, repoPath } = ctx;

  // worktree のクリーンアップ（設定されている場合のみ）
  const worktreePath = ctx.get('worktreePath');
  if (worktreePath) {
    try {
      deps.removeWorktree(repoPath, worktreePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[done] worktreeの削除に失敗しましたが、タスク完了処理を続行します: ${message}`);
    }
  }

  const localOnly = ctx.get('localOnly');

  if (localOnly) {
    const commitSha = ctx.get('commitSha');

    // Vault にローカルオンリー完了として記録
    deps.recordTaskCompletion(task.filePath, {
      mode: 'local-only',
      prUrl: null,
      localCommitSha: commitSha ?? null,
    });

    await notifier.notify(
      `✅ タスク完了（ローカルオンリー）: ${task.slug}\nコミットSHA: ${commitSha ?? 'unknown'}\nPRなし・ローカルコミットのみ`,
      story.slug,
    );
  } else {
    const prUrl = ctx.get('prUrl');

    // Vault に通常完了として記録
    deps.recordTaskCompletion(task.filePath, {
      prUrl: prUrl ?? null,
    });

    await notifier.notify(`✅ タスク完了: ${task.slug}`, story.slug);
  }

  return { kind: 'continue' };
}
