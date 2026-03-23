import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import { syncMainBranch, GitSyncError, detectNoRemote, resetNoRemoteCache } from "../git/sync";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe("syncMainBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正常系: checkout と pull が順番に実行される", async () => {
    mockedExecSync.mockReturnValue(Buffer.from(""));

    await syncMainBranch("/tmp/repo");

    expect(mockedExecSync).toHaveBeenCalledTimes(2);
    expect(mockedExecSync).toHaveBeenNthCalledWith(1, "git checkout main", {
      cwd: "/tmp/repo",
      stdio: "pipe",
    });
    expect(mockedExecSync).toHaveBeenNthCalledWith(2, "git pull origin main", {
      cwd: "/tmp/repo",
      stdio: "pipe",
    });
  });

  it("正常系: [git-sync] プレフィックス付きの開始・完了ログが出力される", async () => {
    mockedExecSync.mockReturnValue(Buffer.from(""));
    const consoleSpy = vi.spyOn(console, "log");

    await syncMainBranch("/tmp/repo");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[git-sync]")
    );
    // 開始ログ
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[git-sync\].*同期を開始/)
    );
    // 完了ログ
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[git-sync\].*同期が完了/)
    );

    consoleSpy.mockRestore();
  });

  it("失敗時は完了ログが出力されない", async () => {
    const error = new Error("command failed") as Error & { stderr: Buffer };
    error.stderr = Buffer.from("error: pathspec 'main' did not match");
    mockedExecSync.mockImplementationOnce(() => {
      throw error;
    });
    const consoleSpy = vi.spyOn(console, "log");

    try {
      await syncMainBranch("/tmp/repo");
    } catch {
      // expected
    }

    // 開始ログは出力される
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[git-sync\].*同期を開始/)
    );
    // 完了ログは出力されない
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/\[git-sync\].*同期が完了/)
    );

    consoleSpy.mockRestore();
  });

  it("checkout 失敗時に GitSyncError がスローされ、stderr の内容が含まれる", async () => {
    const error = new Error("command failed") as Error & { stderr: Buffer };
    error.stderr = Buffer.from("error: pathspec 'main' did not match");
    mockedExecSync.mockImplementationOnce(() => {
      throw error;
    });

    await expect(syncMainBranch("/tmp/repo")).rejects.toThrow(GitSyncError);

    // stderr の内容が含まれていることを確認
    mockedExecSync.mockImplementationOnce(() => {
      throw error;
    });

    try {
      await syncMainBranch("/tmp/repo");
    } catch (e) {
      expect(e).toBeInstanceOf(GitSyncError);
      expect((e as GitSyncError).message).toContain("Failed to checkout main");
      expect((e as GitSyncError).message).toContain(
        "error: pathspec 'main' did not match"
      );
    }
  });

  it("pull 失敗時に GitSyncError がスローされ、stderr の内容が含まれる", async () => {
    // checkout は成功
    mockedExecSync.mockReturnValueOnce(Buffer.from(""));
    // pull は失敗
    const error = new Error("command failed") as Error & { stderr: Buffer };
    error.stderr = Buffer.from("fatal: unable to access remote");
    mockedExecSync.mockImplementationOnce(() => {
      throw error;
    });

    await expect(syncMainBranch("/tmp/repo")).rejects.toThrow(GitSyncError);

    // 再実行して stderr 内容を確認
    mockedExecSync.mockReturnValueOnce(Buffer.from(""));
    mockedExecSync.mockImplementationOnce(() => {
      throw error;
    });

    try {
      await syncMainBranch("/tmp/repo");
    } catch (e) {
      expect(e).toBeInstanceOf(GitSyncError);
      expect((e as GitSyncError).message).toContain("Failed to pull origin main");
      expect((e as GitSyncError).message).toContain(
        "fatal: unable to access remote"
      );
    }
  });
});

describe("detectNoRemote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNoRemoteCache();
  });

  it("リモートが存在する場合は false を返す", () => {
    mockedExecSync.mockReturnValueOnce(Buffer.from("https://github.com/user/repo.git"));

    const result = detectNoRemote("/tmp/repo");

    expect(result).toBe(false);
    expect(mockedExecSync).toHaveBeenCalledWith("git remote get-url origin", {
      cwd: "/tmp/repo",
      stdio: "pipe",
    });
  });

  it("リモートが存在しない場合は true を返す", () => {
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("fatal: No such remote 'origin'");
    });
    const warnSpy = vi.spyOn(console, "warn");

    const result = detectNoRemote("/tmp/repo");

    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ローカルオンリーモード")
    );
    warnSpy.mockRestore();
  });

  it("結果がキャッシュされ、複数回呼び出しても git コマンドは1回だけ実行される", () => {
    mockedExecSync.mockReturnValueOnce(Buffer.from("https://github.com/user/repo.git"));

    const result1 = detectNoRemote("/tmp/repo");
    const result2 = detectNoRemote("/tmp/repo");
    const result3 = detectNoRemote("/tmp/repo");

    expect(result1).toBe(false);
    expect(result2).toBe(false);
    expect(result3).toBe(false);
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it("キャッシュリセット後は再度 git コマンドが実行される", () => {
    mockedExecSync.mockReturnValueOnce(Buffer.from("https://github.com/user/repo.git"));
    detectNoRemote("/tmp/repo");
    expect(mockedExecSync).toHaveBeenCalledTimes(1);

    resetNoRemoteCache();

    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("fatal: No such remote 'origin'");
    });
    const result = detectNoRemote("/tmp/repo");
    expect(result).toBe(true);
    expect(mockedExecSync).toHaveBeenCalledTimes(2);
  });

  it("no-remote キャッシュされた true も複数回呼び出しで再実行しない", () => {
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("fatal: No such remote 'origin'");
    });

    detectNoRemote("/tmp/repo");
    detectNoRemote("/tmp/repo");

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
  });

  it("異なる repoPath ではキャッシュが分離され、それぞれ git コマンドが実行される", () => {
    // /tmp/repo-a はリモートあり
    mockedExecSync.mockReturnValueOnce(Buffer.from("https://github.com/user/repo-a.git"));
    // /tmp/repo-b はリモートなし
    mockedExecSync.mockImplementationOnce(() => {
      throw new Error("fatal: No such remote 'origin'");
    });
    const warnSpy = vi.spyOn(console, "warn");

    const resultA = detectNoRemote("/tmp/repo-a");
    const resultB = detectNoRemote("/tmp/repo-b");

    expect(resultA).toBe(false);
    expect(resultB).toBe(true);
    expect(mockedExecSync).toHaveBeenCalledTimes(2);

    // 再度呼び出してもキャッシュが使われる
    const resultA2 = detectNoRemote("/tmp/repo-a");
    const resultB2 = detectNoRemote("/tmp/repo-b");

    expect(resultA2).toBe(false);
    expect(resultB2).toBe(true);
    expect(mockedExecSync).toHaveBeenCalledTimes(2); // 追加実行なし

    warnSpy.mockRestore();
  });
});
