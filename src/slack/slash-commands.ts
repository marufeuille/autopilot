import type { App } from '@slack/bolt';

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

/** 利用可能なサブコマンド一覧 */
const KNOWN_SUBCOMMANDS = ['retry', 'status'] as const;

/**
 * サブコマンドが既知かどうかを判定する
 */
export function isKnownSubcommand(sub: string): boolean {
  return (KNOWN_SUBCOMMANDS as readonly string[]).includes(sub);
}

/**
 * ヘルプメッセージを生成する
 */
export function buildHelpMessage(): string {
  return [
    '📖 `/ap` コマンドの使い方:',
    '',
    '• `/ap status` — 実行中のストーリー・タスク一覧を表示',
    '• `/ap retry <task-slug>` — 失敗タスクをTodoに戻して再実行',
    '',
    '例: `/ap retry my-feature-task-01`',
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

    // サブコマンドなし or 不明なサブコマンド → ヘルプを即時返答
    if (!parsed.subcommand || !isKnownSubcommand(parsed.subcommand)) {
      await ack(buildHelpMessage());
      return;
    }

    // 既知のサブコマンド → ack() 後に非同期処理
    await ack();

    const handler = handlers.get(parsed.subcommand);
    if (handler) {
      await handler(parsed.args, async (msg: string) => {
        await respond(msg);
      });
    } else {
      // 既知だがハンドラー未登録（将来の拡張用）
      await respond(`⚠️ \`${parsed.subcommand}\` は現在準備中です。`);
    }
  });
}
