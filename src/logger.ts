/**
 * 構造化ログユーティリティ
 *
 * 処理パイプライン全体で統一的なログ出力を提供する。
 * 各ログには タイムスタンプ・レベル・モジュール名・メッセージ・コンテキスト を含む。
 *
 * フォーマット:
 *   pretty (デフォルト): [timestamp] [LEVEL] [module] message {key=value...}
 *   json (LOG_FORMAT=json): {"ts":"...","level":"INFO","module":"...","msg":"...","key":"value"}
 */

/** ログレベル */
export type LogLevel = 'info' | 'warn' | 'error';

/** ログコンテキスト（各ログに付与される構造化情報） */
export interface LogContext {
  /** モジュール名（例: 'runner', 'ci'） */
  module?: string;
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
  module: string;
  message: string;
  context: LogContext;
}

/** デフォルトのモジュール名 */
const DEFAULT_MODULE = 'app';

/** module キーを除外したコンテキストを返す */
function contextWithoutModule(context: LogContext): LogContext {
  const { module: _, ...rest } = context;
  return rest;
}

/**
 * LOG_FORMAT 環境変数を参照して JSON モードかどうかを判定する
 */
function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT === 'json';
}

/**
 * ログエントリを pretty 形式の文字列に変換する
 */
function formatPretty(entry: LogEntry): string {
  const { timestamp, level, module, message, context } = entry;
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${module}]`;

  // コンテキスト情報をコンパクトに表示（module は除外）
  const ctx = contextWithoutModule(context);
  const contextParts: string[] = [];
  if (ctx.command) contextParts.push(`cmd=${ctx.command}`);
  if (ctx.userId) contextParts.push(`user=${ctx.userId}`);
  if (ctx.phase) contextParts.push(`phase=${ctx.phase}`);
  if (ctx.threadTs) contextParts.push(`thread=${ctx.threadTs}`);

  // 標準フィールド以外のコンテキスト
  const standardKeys = new Set(['command', 'userId', 'phase', 'threadTs']);
  for (const [key, value] of Object.entries(ctx)) {
    if (!standardKeys.has(key) && value !== undefined) {
      contextParts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }

  const contextStr = contextParts.length > 0 ? ` {${contextParts.join(', ')}}` : '';
  return `${prefix} ${message}${contextStr}`;
}

/**
 * ログエントリを JSON 形式の文字列に変換する
 */
function formatJson(entry: LogEntry): string {
  const { timestamp, level, module, message, context } = entry;
  const ctx = contextWithoutModule(context);
  return JSON.stringify({
    ts: timestamp,
    level: level.toUpperCase(),
    module,
    msg: message,
    ...ctx,
  });
}

/**
 * ログエントリをフォーマットする
 */
function formatLogEntry(entry: LogEntry): string {
  return isJsonFormat() ? formatJson(entry) : formatPretty(entry);
}

/**
 * 現在のISO 8601タイムスタンプを返す
 */
function now(): string {
  return new Date().toISOString();
}

/**
 * コンテキストからモジュール名を取得する
 */
function resolveModule(context: LogContext): string {
  return (typeof context.module === 'string' && context.module) || DEFAULT_MODULE;
}

/**
 * info レベルのログを出力する
 */
export function logInfo(message: string, context: LogContext = {}): void {
  const entry: LogEntry = {
    timestamp: now(),
    level: 'info',
    module: resolveModule(context),
    message,
    context,
  };
  console.log(formatLogEntry(entry));
}

/**
 * warn レベルのログを出力する
 */
export function logWarn(message: string, context: LogContext = {}): void {
  const entry: LogEntry = {
    timestamp: now(),
    level: 'warn',
    module: resolveModule(context),
    message,
    context,
  };
  console.warn(formatLogEntry(entry));
}

/**
 * error レベルのログを出力する
 *
 * エラーオブジェクトが渡された場合、スタックトレースも出力する。
 */
export function logError(message: string, context: LogContext = {}, error?: unknown): void {
  const entry: LogEntry = {
    timestamp: now(),
    level: 'error',
    module: resolveModule(context),
    message,
    context,
  };
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
 * 特定のモジュール／コマンドに紐づくロガーを生成する
 *
 * 使い方:
 *   // 新しい形式: module を第1引数で指定
 *   const log = createCommandLogger('runner', { command: 'fix' });
 *
 *   // 後方互換: オブジェクトを渡す（module は 'app'）
 *   const log = createCommandLogger({ command: 'fix' });
 */
export function createCommandLogger(moduleOrContext: string | LogContext, baseContext?: LogContext) {
  let effectiveContext: LogContext;

  if (typeof moduleOrContext === 'string') {
    // 新しい形式: createCommandLogger('runner', { command: 'fix' })
    effectiveContext = { ...baseContext, module: moduleOrContext };
  } else {
    // 後方互換: createCommandLogger({ command: 'fix' })
    effectiveContext = { module: DEFAULT_MODULE, ...moduleOrContext };
  }

  return {
    info: (message: string, extraContext: LogContext = {}) =>
      logInfo(message, { ...effectiveContext, ...extraContext }),
    warn: (message: string, extraContext: LogContext = {}) =>
      logWarn(message, { ...effectiveContext, ...extraContext }),
    error: (message: string, extraContext: LogContext = {}, error?: unknown) =>
      logError(message, { ...effectiveContext, ...extraContext }, error),
  };
}
