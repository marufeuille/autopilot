/**
 * 構造化ログユーティリティ
 *
 * 処理パイプライン全体で統一的なログ出力を提供する。
 * 各ログには タイムスタンプ・コマンド種別・ユーザーID・処理フェーズ・スレッドts を含む。
 */

/** ログレベル */
export type LogLevel = 'info' | 'warn' | 'error';

/** ログコンテキスト（各ログに付与される構造化情報） */
export interface LogContext {
  /** コマンド種別（例: 'fix', 'story'） */
  command?: string;
  /** ユーザーID */
  userId?: string;
  /** 処理フェーズ（例: 'command_received', 'analysis_start'） */
  phase?: string;
  /** スレッドのタイムスタンプ */
  threadTs?: string;
  /** その他の任意のコンテキスト情報 */
  [key: string]: unknown;
}

/**
 * 構造化ログエントリ
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: LogContext;
}

/**
 * ログエントリを整形された文字列に変換する
 */
function formatLogEntry(entry: LogEntry): string {
  const { timestamp, level, message, context } = entry;
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

  // コンテキスト情報をコンパクトに表示
  const contextParts: string[] = [];
  if (context.command) contextParts.push(`cmd=${context.command}`);
  if (context.userId) contextParts.push(`user=${context.userId}`);
  if (context.phase) contextParts.push(`phase=${context.phase}`);
  if (context.threadTs) contextParts.push(`thread=${context.threadTs}`);

  // 標準フィールド以外のコンテキスト
  const standardKeys = new Set(['command', 'userId', 'phase', 'threadTs']);
  for (const [key, value] of Object.entries(context)) {
    if (!standardKeys.has(key) && value !== undefined) {
      contextParts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }

  const contextStr = contextParts.length > 0 ? ` {${contextParts.join(', ')}}` : '';
  return `${prefix} ${message}${contextStr}`;
}

/**
 * 現在のISO 8601タイムスタンプを返す
 */
function now(): string {
  return new Date().toISOString();
}

/**
 * info レベルのログを出力する
 */
export function logInfo(message: string, context: LogContext = {}): void {
  const entry: LogEntry = { timestamp: now(), level: 'info', message, context };
  console.log(formatLogEntry(entry));
}

/**
 * warn レベルのログを出力する
 */
export function logWarn(message: string, context: LogContext = {}): void {
  const entry: LogEntry = { timestamp: now(), level: 'warn', message, context };
  console.warn(formatLogEntry(entry));
}

/**
 * error レベルのログを出力する
 *
 * エラーオブジェクトが渡された場合、スタックトレースも出力する。
 */
export function logError(message: string, context: LogContext = {}, error?: unknown): void {
  const entry: LogEntry = { timestamp: now(), level: 'error', message, context };
  const formatted = formatLogEntry(entry);

  if (error instanceof Error) {
    console.error(formatted, { error: error.message, stack: error.stack });
  } else if (error !== undefined) {
    console.error(formatted, { error: String(error) });
  } else {
    console.error(formatted);
  }
}

/**
 * 特定のコマンドに紐づくロガーを生成する
 *
 * コマンド種別やユーザーIDなど、共通のコンテキストを事前にバインドして
 * 繰り返し指定する手間を省く。
 */
export function createCommandLogger(baseContext: LogContext) {
  return {
    info: (message: string, extraContext: LogContext = {}) =>
      logInfo(message, { ...baseContext, ...extraContext }),
    warn: (message: string, extraContext: LogContext = {}) =>
      logWarn(message, { ...baseContext, ...extraContext }),
    error: (message: string, extraContext: LogContext = {}, error?: unknown) =>
      logError(message, { ...baseContext, ...extraContext }, error),
  };
}
