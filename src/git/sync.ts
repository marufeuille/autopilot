import { execSync } from "child_process";

export class GitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSyncError";
  }
}

/**
 * main ブランチをチェックアウトし、最新の状態に同期する。
 * git checkout main → git pull origin main を順番に実行する。
 * いずれかのコマンドが失敗した場合は GitSyncError をスローする。
 */
export async function syncMainBranch(repoPath: string): Promise<void> {
  console.log(`[git-sync] mainブランチの同期を開始します (${repoPath})`);

  try {
    execSync("git checkout main", {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch (error: unknown) {
    const stderr = error instanceof Error && "stderr" in error
      ? String((error as { stderr: unknown }).stderr)
      : String(error);
    throw new GitSyncError(`Failed to checkout main: ${stderr}`);
  }

  try {
    execSync("git pull origin main", {
      cwd: repoPath,
      stdio: "pipe",
    });
  } catch (error: unknown) {
    const stderr = error instanceof Error && "stderr" in error
      ? String((error as { stderr: unknown }).stderr)
      : String(error);
    throw new GitSyncError(`Failed to pull origin main: ${stderr}`);
  }

  console.log(`[git-sync] mainブランチの同期が完了しました`);
}
