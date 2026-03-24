/**
 * マージサービス
 *
 * PRステータスの取得を行う。
 */

import {
  MergeError,
  PullRequestStatus,
} from './types';

/**
 * gh CLI 実行の依存インターフェース
 */
export interface MergeServiceDeps {
  execGh: (args: string[], cwd: string) => string;
}

/**
 * PRのステータスを取得する
 *
 * @param prUrl PR URL
 * @param cwd 作業ディレクトリ
 * @param deps 依存注入
 * @returns PRステータス情報
 */
export function fetchPullRequestStatus(
  prUrl: string,
  cwd: string,
  deps: MergeServiceDeps,
): PullRequestStatus {
  try {
    const json = deps.execGh(
      [
        'pr', 'view', prUrl,
        '--json', 'state,mergeable,reviewDecision,statusCheckRollup',
      ],
      cwd,
    );
    const data = JSON.parse(json);
    return {
      state: data.state ?? 'UNKNOWN',
      mergeable: data.mergeable ?? 'UNKNOWN',
      reviewDecision: data.reviewDecision ?? '',
      statusCheckRollup: (data.statusCheckRollup ?? []).map((check: Record<string, string>) => ({
        name: check.name ?? '',
        status: check.status ?? '',
        conclusion: check.conclusion ?? '',
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MergeError(
      'unknown',
      `PRステータスの取得に失敗しました: ${message}`,
      500,
      error instanceof Error ? error : undefined,
    );
  }
}
