/**
 * マージ状態ポーリングループ
 *
 * PRがMERGED/CLOSEDになるまでポーリングして待機する。
 * ユーザーが GitHub 上で手動マージする運用を前提とし、
 * autopilot はマージ完了を検知して次のステップへ進む。
 *
 * Slack の NG ボタンによる却下シグナル（RejectionRegistry）にも対応し、
 * ポーリングと rejection を Promise.race で競合させる。
 */

import { MergePollingOptions, MergePollingResult } from './types';
import { fetchPullRequestStatus, MergeServiceDeps } from './merge-service';
import { sleep } from '../ci/poller';
import { waitForRejection, cancelWaitForRejection } from './rejection-registry';

const DEFAULT_POLLING_INTERVAL_MS = 30_000; // 30秒
const DEFAULT_MAX_WAIT_MS = 86_400_000; // 24時間
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;

/**
 * runPollingInternal の引数をまとめた構造体
 */
interface PollingInternalOptions {
  prUrl: string;
  cwd: string;
  deps: MergeServiceDeps;
  pollingInterval: number;
  maxWait: number;
  maxConsecutiveErrors: number;
  startTime: number;
  abortSignal: { aborted: boolean };
}

/**
 * ポーリングループの内部実装（Promise に包んで Promise.race に渡す用）
 *
 * aborted フラグが true になったらループを抜ける（rejection 側が先に完了した場合のクリーンアップ）
 */
async function runPollingInternal(
  options: PollingInternalOptions,
): Promise<MergePollingResult> {
  const {
    prUrl, cwd, deps, pollingInterval, maxWait,
    maxConsecutiveErrors, startTime, abortSignal,
  } = options;
  let consecutiveErrors = 0;

  while (!abortSignal.aborted) {
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

  // aborted の場合（rejection が先に完了）— この値は Promise.race で使われない
  return { finalStatus: 'timeout', elapsedMs: Date.now() - startTime };
}

/**
 * PRがMERGED/CLOSEDになるまでポーリングする
 *
 * fetchPullRequestStatus を使って PR の state を定期的に確認し、
 * MERGED なら 'merged'、CLOSED（未マージ）なら 'closed' を返す。
 * タイムアウトに達した場合は 'timeout' を返す。
 *
 * Slack の NG ボタンから rejection シグナルが送られた場合は
 * finalStatus: 'rejected' と rejectionReason を返す。
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
  const abortSignal = { aborted: false };

  // rejection シグナルを待機する Promise
  const rejectionPromise = waitForRejection(prUrl).then((reason) => ({
    finalStatus: 'rejected' as const,
    rejectionReason: reason,
    elapsedMs: Date.now() - startTime,
  }));

  // ポーリングループ本体
  const pollingPromise = runPollingInternal({
    prUrl, cwd, deps, pollingInterval, maxWait,
    maxConsecutiveErrors, startTime, abortSignal,
  });

  // Promise.race で競合させる
  const result = await Promise.race([pollingPromise, rejectionPromise]);

  if (result.finalStatus === 'rejected') {
    // rejection が先に完了 → ポーリングループを停止
    abortSignal.aborted = true;
  } else {
    // ポーリングが先に完了 → registry のクリーンアップ
    // cancelWaitForRejection は rejectionPromise を resolve して
    // メモリリークを防止する
    cancelWaitForRejection(prUrl);
  }

  return result;
}
