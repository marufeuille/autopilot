/**
 * マージサービス
 *
 * PRマージの事前検証と実行を行う。
 * 条件未充足・権限不足時に構造化されたエラーを返す。
 */

import {
  MergeError,
  MergeResult,
  MergeValidationResult,
  PullRequestStatus,
  StatusCheck,
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

/**
 * マージ前のバリデーションを実行する
 *
 * CI完了状態、承認数、PRの状態を検証し、
 * 条件未充足の場合は構造化されたエラー一覧を返す。
 *
 * @param status PRステータス情報
 * @returns バリデーション結果
 */
export function validateMergeConditions(status: PullRequestStatus): MergeValidationResult {
  const errors: MergeValidationResult['errors'] = [];

  // PRがオープン状態であること
  if (status.state !== 'OPEN') {
    errors.push({
      code: 'pr_not_open',
      message: `PRがオープン状態ではありません（現在: ${status.state}）`,
    });
  }

  // CIチェックの検証
  if (status.statusCheckRollup.length > 0) {
    const pendingChecks = status.statusCheckRollup.filter(
      (check: StatusCheck) =>
        check.status === 'IN_PROGRESS' ||
        check.status === 'QUEUED' ||
        check.status === 'PENDING',
    );

    const failedChecks = status.statusCheckRollup.filter(
      (check: StatusCheck) =>
        check.conclusion !== '' &&
        check.conclusion !== 'SUCCESS' &&
        check.conclusion !== 'NEUTRAL' &&
        check.conclusion !== 'SKIPPED' &&
        !pendingChecks.includes(check),
    );

    if (pendingChecks.length > 0) {
      const names = pendingChecks.map((c: StatusCheck) => c.name).join(', ');
      errors.push({
        code: 'ci_not_passed',
        message: `CIが未完了です（実行中: ${names}）`,
      });
    } else if (failedChecks.length > 0) {
      const names = failedChecks.map((c: StatusCheck) => c.name).join(', ');
      errors.push({
        code: 'ci_not_passed',
        message: `CIが失敗しています（失敗: ${names}）`,
      });
    }
  }

  // レビュー承認の検証
  if (
    status.reviewDecision === 'CHANGES_REQUESTED' ||
    status.reviewDecision === 'REVIEW_REQUIRED'
  ) {
    errors.push({
      code: 'insufficient_approvals',
      message: status.reviewDecision === 'CHANGES_REQUESTED'
        ? '変更がリクエストされています。レビュー指摘への対応が必要です'
        : '承認数が不足しています。必要な承認を取得してください',
    });
  }

  // マージコンフリクトの検証
  if (status.mergeable === 'CONFLICTING') {
    errors.push({
      code: 'merge_conflict',
      message: 'マージコンフリクトが発生しています。コンフリクトを解消してください',
    });
  }

  return {
    mergeable: errors.length === 0,
    errors,
  };
}

/**
 * gh pr merge のエラーメッセージからエラーコードを分類する
 *
 * @param errorMessage gh CLI のエラーメッセージ
 * @returns 分類されたマージエラー
 */
export function classifyMergeError(errorMessage: string): MergeError {
  const lower = errorMessage.toLowerCase();

  // 権限不足
  if (
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('403') ||
    lower.includes('not allowed') ||
    lower.includes('authorization')
  ) {
    return new MergeError(
      'permission_denied',
      `マージ権限がありません: ${errorMessage}`,
      403,
    );
  }

  // ブランチ保護ルール
  if (
    lower.includes('protected branch') ||
    lower.includes('branch protection') ||
    lower.includes('required status check')
  ) {
    return new MergeError(
      'branch_protected',
      `ブランチ保護ルールにより、マージがブロックされています: ${errorMessage}`,
      422,
    );
  }

  // マージコンフリクト
  if (
    lower.includes('conflict') ||
    lower.includes('not mergeable') ||
    lower.includes('merge conflict')
  ) {
    return new MergeError(
      'merge_conflict',
      `マージコンフリクトが発生しています: ${errorMessage}`,
      409,
    );
  }

  // CI未通過
  if (
    lower.includes('check') ||
    lower.includes('ci') ||
    lower.includes('status') ||
    lower.includes('workflow')
  ) {
    return new MergeError(
      'ci_not_passed',
      `CIチェックが未通過です: ${errorMessage}`,
      422,
    );
  }

  // PR状態
  if (
    lower.includes('already merged') ||
    lower.includes('closed') ||
    lower.includes('not open')
  ) {
    return new MergeError(
      'pr_not_open',
      `PRがマージ可能な状態ではありません: ${errorMessage}`,
      422,
    );
  }

  // 承認不足
  if (
    lower.includes('review') ||
    lower.includes('approv')
  ) {
    return new MergeError(
      'insufficient_approvals',
      `承認数が不足しています: ${errorMessage}`,
      422,
    );
  }

  // その他
  return new MergeError(
    'unknown',
    `マージに失敗しました: ${errorMessage}`,
    500,
  );
}

/**
 * PRのマージを実行する
 *
 * 事前にバリデーションを行い、条件未充足の場合は構造化されたエラーをスローする。
 * マージ実行時のエラーも分類して構造化されたエラーとして返す。
 *
 * @param prUrl PR URL
 * @param cwd 作業ディレクトリ
 * @param deps 依存注入
 * @param options マージオプション
 * @returns マージ結果
 * @throws {MergeError} マージ失敗時
 */
export function executeMerge(
  prUrl: string,
  cwd: string,
  deps: MergeServiceDeps,
  options?: { skipValidation?: boolean },
): MergeResult {
  // 事前バリデーション（skipValidation が true の場合はスキップ）
  if (!options?.skipValidation) {
    const status = fetchPullRequestStatus(prUrl, cwd, deps);
    const validation = validateMergeConditions(status);

    if (!validation.mergeable) {
      const firstError = validation.errors[0];
      const allMessages = validation.errors.map((e) => e.message).join('; ');
      const statusCode = firstError.code === 'permission_denied' ? 403
        : firstError.code === 'merge_conflict' ? 409
        : 422;

      throw new MergeError(
        firstError.code,
        allMessages,
        statusCode,
      );
    }
  }

  // マージ実行
  try {
    const output = deps.execGh(
      ['pr', 'merge', prUrl, '--squash', '--delete-branch'],
      cwd,
    );
    console.log(`[merge-service] PR merged successfully: ${prUrl}`);
    return {
      success: true,
      prUrl,
      output: output.trim() || undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[merge-service] PR merge failed: ${prUrl} — ${errorMessage}`);
    throw classifyMergeError(errorMessage);
  }
}

/**
 * MergeError のユーザー向けメッセージをフォーマットする
 *
 * @param error MergeError
 * @returns フォーマットされたエラーメッセージ
 */
export function formatMergeErrorMessage(error: MergeError): string {
  const iconMap: Record<string, string> = {
    ci_not_passed: '🔴',
    insufficient_approvals: '👥',
    permission_denied: '🔒',
    merge_conflict: '⚠️',
    branch_protected: '🛡️',
    pr_not_open: '📋',
    unknown: '❌',
  };
  const icon = iconMap[error.code] ?? '❌';
  return `${icon} ${error.reason}`;
}
