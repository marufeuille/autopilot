/**
 * マージ状態ポーリングループ
 *
 * PRがMERGED/CLOSEDになるまでポーリングして待機する。
 * ユーザーが GitHub 上で手動マージする運用を前提とし、
 * autopilot はマージ完了を検知して次のステップへ進む。
 */

import { MergePollingOptions, MergePollingResult } from './types';
import { fetchPullRequestStatus, MergeServiceDeps } from './merge-service';
import { sleep } from '../ci/poller';

const DEFAULT_POLLING_INTERVAL_MS = 30_000; // 30秒
const DEFAULT_MAX_WAIT_MS = 86_400_000; // 24時間
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;

/**
 * PRがMERGED/CLOSEDになるまでポーリングする
 *
 * fetchPullRequestStatus を使って PR の state を定期的に確認し、
 * MERGED なら 'merged'、CLOSED（未マージ）なら 'closed' を返す。
 * タイムアウトに達した場合は 'timeout' を返す。
 *
 * 一時的なエラー（ネットワーク障害、gh CLI タイムアウト等）が発生した場合は
 * ログを出力して次のポーリングへ続行する。連続エラーが上限に達した場合は
 * finalStatus: 'error' を返す。
 *
 * @param prUrl PR URL
 * @param cwd 作業ディレクトリ
 * @param deps 依存注入（gh CLI実行）
 * @param options ポーリング設定
 * @returns ポーリング結果
 */
export async function runMergePollingLoop(
  prUrl: string,
  cwd: string,
  deps: MergeServiceDeps,
  options: MergePollingOptions = {},
): Promise<MergePollingResult> {
  const pollingInterval = options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
  const maxWait = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;

  // バリデーション: 不正な値を防止
  if (!Number.isFinite(pollingInterval) || pollingInterval <= 0) {
    throw new Error(`pollingIntervalMs must be a positive finite number, got: ${pollingInterval}`);
  }
  if (!Number.isFinite(maxWait) || maxWait < 0) {
    throw new Error(`maxWaitMs must be a non-negative finite number, got: ${maxWait}`);
  }

  const startTime = Date.now();
  let consecutiveErrors = 0;

  while (true) {
    const elapsed = Date.now() - startTime;

    if (elapsed >= maxWait) {
      console.log(`[merge-polling] timed out after ${elapsed}ms`);
      return { finalStatus: 'timeout', elapsedMs: elapsed };
    }

    try {
      const status = fetchPullRequestStatus(prUrl, cwd, deps);
      console.log(`[merge-polling] state=${status.state}, elapsed=${elapsed}ms`);
      consecutiveErrors = 0; // 成功したらリセット

      if (status.state === 'MERGED') {
        const elapsedMs = Date.now() - startTime;
        console.log(`[merge-polling] PR merged after ${elapsedMs}ms`);
        return { finalStatus: 'merged', elapsedMs };
      }

      if (status.state === 'CLOSED') {
        const elapsedMs = Date.now() - startTime;
        console.log(`[merge-polling] PR closed (not merged) after ${elapsedMs}ms`);
        return { finalStatus: 'closed', elapsedMs };
      }
    } catch (error) {
      consecutiveErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[merge-polling] error fetching PR status (attempt ${consecutiveErrors}/${maxConsecutiveErrors}): ${message}`,
      );

      if (consecutiveErrors >= maxConsecutiveErrors) {
        const elapsedMs = Date.now() - startTime;
        console.error(
          `[merge-polling] max consecutive errors (${maxConsecutiveErrors}) reached after ${elapsedMs}ms`,
        );
        return { finalStatus: 'error', elapsedMs };
      }
    }

    // 残り時間よりポーリング間隔が長い場合は残り時間だけ待機
    const remaining = maxWait - (Date.now() - startTime);
    const waitTime = Math.min(pollingInterval, remaining);
    if (waitTime > 0) {
      console.log(`[merge-polling] waiting ${waitTime}ms before next poll`);
      await sleep(waitTime);
    }
  }
}
