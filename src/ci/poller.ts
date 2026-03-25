import { execSync } from 'child_process';
import {
  CIPollingOptions,
  CIRunResult,
  CIStatus,
  CIPollingError,
  CIPollingTimeoutError,
} from './types';

const DEFAULT_POLLING_INTERVAL_MS = 30_000; // 30秒
const DEFAULT_MAX_WAIT_MS = 900_000; // 15分

/**
 * sleep ユーティリティ
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PR に関連する CI ステータスをポーリングで取得する
 *
 * `gh run list` で最新のワークフロー実行を取得し、
 * ステータスが completed になるまでポーリングする。
 */
export async function pollCIStatus(
  repoPath: string,
  branch: string,
  options: CIPollingOptions = {},
): Promise<CIRunResult> {
  const pollingInterval = options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
  const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxWait) {
      throw new CIPollingTimeoutError(maxWait);
    }

    const status = getCIStatus(repoPath, branch);
    console.log(`[ci-poller] status=${status.status}, elapsed=${elapsed}ms`);

    if (status.status !== 'pending') {
      return status;
    }

    // 残り時間よりポーリング間隔が長い場合は残り時間だけ待機
    const remaining = maxWait - elapsed;
    const waitTime = Math.min(pollingInterval, remaining);
    console.log(`[ci-poller] waiting ${waitTime}ms before next poll`);
    await sleep(waitTime);
  }
}

/**
 * ブランチの最新 CI ステータスを取得する
 */
export function getCIStatus(repoPath: string, branch: string): CIRunResult {
  try {
    // gh run list でブランチに関連するワークフロー実行を取得
    const output = execSync(
      `gh run list --branch ${branch} --limit 1 --json databaseId,status,conclusion,name,url`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
      },
    );

    const runs = JSON.parse(output);

    if (!runs || runs.length === 0) {
      // CI 実行がまだ存在しない（PR作成直後でキュー前の可能性あり）
      return {
        status: 'pending',
        summary: 'No CI runs found for this branch (CI may not have started yet)',
        reason: 'no_runs_yet',
      };
    }

    const run = runs[0];
    const status = mapGitHubStatus(run.status, run.conclusion);

    const result: CIRunResult = {
      status,
      summary: `${run.name}: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}`,
      runUrl: run.url,
    };

    // 失敗時はログを取得
    if (status === 'failure' && run.databaseId) {
      result.failureLogs = getFailureLogs(repoPath, run.databaseId);
    }

    return result;
  } catch (error) {
    // gh CLI がない等、CI ステータス取得に失敗した場合
    throw new CIPollingError(
      `Failed to get CI status: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * GitHub Actions のステータスを CIStatus に変換する
 */
export function mapGitHubStatus(
  status: string,
  conclusion: string | null,
): CIStatus {
  if (status === 'completed') {
    if (conclusion === 'success') return 'success';
    return 'failure'; // failure, cancelled, timed_out, etc.
  }
  // queued, in_progress, waiting, requested, pending
  return 'pending';
}

/**
 * 失敗した CI 実行のログを取得する
 */
export function getFailureLogs(
  repoPath: string,
  runId: number,
): string {
  try {
    // gh run view で失敗したジョブのログを取得
    const output = execSync(
      `gh run view ${runId} --log-failed`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: 5 * 1024 * 1024, // 5MB
      },
    );

    // ログが長すぎる場合は末尾を切り詰め
    const maxLength = 10_000;
    if (output.length > maxLength) {
      return `...(truncated)\n${output.slice(-maxLength)}`;
    }

    return output;
  } catch {
    return 'Failed to retrieve CI logs';
  }
}
