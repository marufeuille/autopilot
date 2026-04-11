/**
 * Slack コマンド共通ユーティリティ
 */
import { config } from '../../config';

/**
 * args から --project=xxx オプションを抽出する
 */
export function extractProjectOption(
  args: string[],
): { project: string | undefined; remainingArgs: string[] } {
  const remainingArgs: string[] = [];
  let project: string | undefined;

  for (const arg of args) {
    const match = arg.match(/^--project=(.+)$/);
    if (match) {
      project = match[1];
    } else {
      remainingArgs.push(arg);
    }
  }

  return { project, remainingArgs };
}

/**
 * プロジェクト名のバリデーションエラー
 */
export class InvalidProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProjectError';
  }
}

/**
 * 指定されたプロジェクト名を検証し、有効なプロジェクト名を返す。
 * - specifiedProject が指定された場合、watchProjects に含まれるかチェックする
 * - 未指定の場合は watchProjects[0] にフォールバックする
 * - watchProjects が空の場合はエラーを投げる
 *
 * @throws {InvalidProjectError} プロジェクト名が不正な場合
 */
export function resolveProject(specifiedProject: string | undefined): string {
  if (config.watchProjects.length === 0) {
    throw new InvalidProjectError(
      'watchProjects が設定されていません。環境変数 WATCH_PROJECT を設定してください。',
    );
  }

  if (specifiedProject === undefined) {
    return config.watchProjects[0];
  }

  // プロジェクト名の形式バリデーション（英数字・ハイフン・アンダースコアのみ）
  if (!/^[a-zA-Z0-9_-]+$/.test(specifiedProject)) {
    throw new InvalidProjectError(
      `不正なプロジェクト名です: "${specifiedProject}"。英数字・ハイフン・アンダースコアのみ使用できます。`,
    );
  }

  // watchProjects に含まれるかチェック
  if (!config.watchProjects.includes(specifiedProject)) {
    throw new InvalidProjectError(
      `プロジェクト "${specifiedProject}" は登録されていません。利用可能: ${config.watchProjects.join(', ')}`,
    );
  }

  return specifiedProject;
}
