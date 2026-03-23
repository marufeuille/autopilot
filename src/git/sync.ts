import { execSync } from "child_process";

export class GitSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSyncError";
  }
}

/**
 * リモートリポジトリの有無を検出する。
 * `git remote get-url origin` を実行し、失敗（exit code !== 0）なら true を返す。
 * 結果はプロセス内で repoPath ごとにキャッシュし、複数回呼び出しても git コマンドは1回だけ実行する。
 */
const noRemoteCache = new Map<string, boolean>();

export function detectNoRemote(repoPath: string): boolean {
  const cached = noRemoteCache.get(repoPath);
  if (cached !== undefined) {
    return cached;
  }

  try {
    execSync("git remote get-url origin", {
      cwd: repoPath,
      stdio: "pipe",
    });
    noRemoteCache.set(repoPath, false);
    return false;
  } catch {
    console.warn("[git-sync] リモート 'origin' が見つかりません。ローカルオンリーモードで動作します。");
    noRemoteCache.set(repoPath, true);
    return true;
  }
}

/**
 * テスト用: キャッシュをリセットする。
 */
export function resetNoRemoteCache(): void {
  noRemoteCache.clear();
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
