import type { App } from '@slack/bolt';
import { logInfo, logWarn, logError } from '../logger';

/**
 * パースされたスラッシュコマンドの構造
 */
export interface ParsedCommand {
  /** サブコマンド名（例: "retry", "status"）。空文字列の場合はサブコマンドなし */
  subcommand: string;
  /** サブコマンドに続く引数リスト */
  args: string[];
}

/**
 * `/ap` コマンドのテキスト部分をパースし、サブコマンドと引数に分離する。
 *
 * @param text - Slack が送ってくるコマンドテキスト（例: "retry my-task"）
 * @returns パース結果
 */
export function parseCommand(text: string): ParsedCommand {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { subcommand: '', args: [] };
  }
  const [subcommand, ...args] = tokens;
  return { subcommand, args };
}

/** サブコマンド入力の最大長 */
const MAX_SUBCOMMAND_LENGTH = 50;

/**
 * Slack mrkdwn 向けにユーザー入力をサニタイズする。
 *
 * - 長さを制限し、超過分は省略記号で切り詰める
 * - HTML特殊文字（<, >, &）をエスケープする
 * - @channel, @here, @everyone 等のメンション記法を無効化する
 */
export function sanitizeForMrkdwn(text: string): string {
  const truncated = text.length > MAX_SUBCOMMAND_LENGTH
    ? text.slice(0, MAX_SUBCOMMAND_LENGTH) + '…'
    : text;
  return truncated
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(channel|here|everyone)/gi, '@ $1');
}

/**
 * サブコマンドが既知（ハンドラー登録済み）かどうかを判定する
 */
export function isKnownSubcommand(sub: string): boolean {
  return handlers.has(sub);
}

/**
 * 登録済みサブコマンド名の一覧を返す
 */
export function getRegisteredSubcommands(): string[] {
  return Array.from(handlers.keys());
}

/**
 * ヘルプメッセージを生成する
 */
export function buildHelpMessage(): string {
  return [
    '📖 `/ap` コマンドの使い方:',
    '',
    '• `/ap story <概要>` — Claudeと壁打ちしながらストーリーを作成（スレッド内でマルチターン対話）',
    '• `/ap fix <バグ説明>` — バグの原因・修正方針をClaudeが提示し、承認後に自動修正を開始',
    '• `/ap status` — 実行中のストーリー・タスク一覧を表示',
    '• `/ap retry <task-slug>` — 失敗タスクをTodoに戻して再実行',
    '• `/ap queue add <story-slug>` — ストーリーをキューに追加',
    '• `/ap queue cancel <story-slug>` — ストーリーをキューから削除',
    '• `/ap queue list` — キューの内容を表示',
    '• `/ap help` — このヘルプメッセージを表示',
    '',
    '例:',
    '  `/ap story ユーザープロフィール画面にアバター画像アップロード機能を追加`',
    '  `/ap fix ログインページでパスワードリセットリンクが404になる`',
    '  `/ap retry my-feature-task-01`',
  ].join('\n');
}

/**
 * サブコマンドのハンドラー型
 *
 * ack() は呼び出し元で既に実行済み。respond() で非同期返答する。
 */
export type SubcommandHandler = (
  args: string[],
  respond: (msg: string) => Promise<void>,
) => Promise<void>;

/** サブコマンド → ハンドラーの登録マップ */
const handlers = new Map<string, SubcommandHandler>();

/**
 * サブコマンドハンドラーを登録する
 */
export function registerSubcommand(name: string, handler: SubcommandHandler): void {
  handlers.set(name, handler);
}

/**
 * 登録済みのサブコマンドハンドラーをすべてクリアする（テスト用）
 */
export function clearSubcommands(): void {
  handlers.clear();
}

/**
 * Slack App に `/ap` コマンドハンドラーを登録する。
 *
 * Slack Bolt の command() ハンドラーは 3 秒以内に ack() を返す必要があるため、
 * まず ack() で即時応答し、重い処理は respond() で非同期返答するパターンを採用する。
 */
export function registerSlashCommands(app: App): void {
  app.command('/ap', async ({ command, ack, respond }) => {
    const parsed = parseCommand(command.text);
    const userId = command.user_id;

    logInfo('スラッシュコマンド受信', {
      command: parsed.subcommand || '(none)',
      userId,
      phase: 'slash_command_received',
    });

    // サブコマンドなし → ヘルプメッセージを即時返答
    if (!parsed.subcommand) {
      await ack(buildHelpMessage());
      return;
    }

    // ハンドラー未登録のサブコマンド → サニタイズ済みエラーメッセージを即時返答
    const handler = handlers.get(parsed.subcommand);
    if (!handler) {
      const sanitized = sanitizeForMrkdwn(parsed.subcommand);
      const available = getRegisteredSubcommands().join(', ');
      logWarn('不明なサブコマンド', {
        command: parsed.subcommand,
        userId,
        phase: 'unknown_subcommand',
      });
      await ack(
        `⚠️ 不明なサブコマンド: \`${sanitized}\`\n\n` +
        `利用可能なサブコマンド: ${available}\n` +
        `詳しくは \`/ap help\` を実行してください。`,
      );
      return;
    }

    // 登録済みサブコマンド → ack() 後にハンドラーへディスパッチ
    await ack();

    logInfo('サブコマンドにディスパッチ', {
      command: parsed.subcommand,
      userId,
      phase: 'dispatch',
    });

    try {
      await handler(parsed.args, async (msg: string) => {
        await respond(msg);
      });
    } catch (error) {
      logError('サブコマンドハンドラーでエラーが発生', {
        command: parsed.subcommand,
        userId,
        phase: 'handler_error',
      }, error);
    }
  });
}
