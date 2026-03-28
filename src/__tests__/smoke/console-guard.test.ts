import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 外部I/Oのモック: chokidar（ファイルシステム監視を防止）
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
    })),
  },
}));

/**
 * logger フォーマットのパターン
 * pretty: [2024-01-01T00:00:00.000Z] [INFO] [module] message
 * json:   {"ts":"...","level":"INFO","module":"...","msg":"..."}
 */
const LOGGER_PRETTY_PATTERN = /^\[\d{4}-\d{2}-\d{2}T.*\] \[(INFO|WARN|ERROR)\]/;
const LOGGER_JSON_PATTERN = /^\{"ts":".*","level":"(INFO|WARN|ERROR)"/;

/**
 * 意図的に console を直接使用しているモジュールの許可リスト
 * - src/review/cli.ts: CLI エントリポイント（ユーザー向け出力）
 * - src/notification/local.ts: ローカル通知バックエンド（ターミナル対話）
 * - src/logger.ts: ログユーティリティ自体（console.log/warn/error の呼び出し元）
 * - src/index.ts: エントリポイント（TODO: logger 移行後に許可リストから除外する）
 */
const ALLOWED_FILES = [
  'src/review/cli.ts',
  'src/notification/local.ts',
  'src/logger.ts',
  'src/index.ts',
];

/** スタックトレースから呼び出し元ファイルが許可リストに含まれるか判定する */
function isFromAllowedFile(stack: string | undefined): boolean {
  if (!stack) return false;
  return ALLOWED_FILES.some((file) => stack.includes(file));
}

/** メッセージが logger フォーマットに沿っているか判定する */
function isLoggerFormatted(msg: unknown): boolean {
  const str = String(msg);
  return LOGGER_PRETTY_PATTERN.test(str) || LOGGER_JSON_PATTERN.test(str);
}

interface ConsoleCall {
  method: 'log' | 'warn' | 'error';
  args: unknown[];
  stack: string | undefined;
}

describe('smoke: console-guard', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const capturedCalls: ConsoleCall[] = [];

  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const envKeys = [
    'VAULT_PATH',
    'WATCH_PROJECT',
    'NOTIFY_BACKEND',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_CHANNEL_ID',
    'NTFY_TOPIC',
    'LOG_FORMAT',
  ];

  /** console メソッドをスパイし、呼び出しを記録する */
  function spyConsoleMethod(method: 'log' | 'warn' | 'error') {
    const original = console[method];
    return vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const stack = new Error().stack;
      capturedCalls.push({ method, args, stack });
      // テスト中のデバッグ用にオリジナルを呼ばない（ノイズ防止）
    });
  }

  beforeEach(() => {
    capturedCalls.length = 0;

    // 環境変数を退避
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }

    // Vault 用の一時ディレクトリを作成
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-console-'));
    const project = 'test-project';
    const storiesDir = path.join(tmpDir, 'Projects', project, 'stories');
    fs.mkdirSync(storiesDir, { recursive: true });

    // 外部サービスに依存する環境変数をモック
    process.env.VAULT_PATH = tmpDir;
    process.env.WATCH_PROJECT = project;
    process.env.NOTIFY_BACKEND = 'local';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_CHANNEL_ID = 'C00000000';
    process.env.NTFY_TOPIC = 'test-topic';

    // console をスパイ
    logSpy = spyConsoleMethod('log');
    warnSpy = spyConsoleMethod('warn');
    errorSpy = spyConsoleMethod('error');
  });

  afterEach(() => {
    // スパイを確実にリストア
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    // 環境変数を復元
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }

    // 一時ディレクトリを削除
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * 記録された console 呼び出しを検証する。
   * logger フォーマットに沿っていないかつ許可リストのモジュールからでもない
   * 呼び出しがあればテスト失敗とする。
   */
  function assertNoUnstructuredConsoleOutput(): void {
    const violations = capturedCalls.filter((call) => {
      // logger フォーマットに沿っている → OK
      if (call.args.length > 0 && isLoggerFormatted(call.args[0])) {
        return false;
      }
      // 許可リストのファイルから呼ばれている → OK
      if (isFromAllowedFile(call.stack)) {
        return false;
      }
      // それ以外は違反
      return true;
    });

    if (violations.length > 0) {
      const details = violations
        .map((v, i) => {
          const msg = v.args.map((a) => String(a)).join(' ');
          return `  [${i + 1}] console.${v.method}(${msg})`;
        })
        .join('\n');
      throw new Error(
        `非構造化 console 出力を ${violations.length} 件検出:\n${details}`,
      );
    }
  }

  it('主要モジュール import 時に非構造化 console 出力がない', async () => {
    // 主要モジュールを import（起動シーケンスで console が呼ばれるかを検証）
    await import('../../index');
    await import('../../notification');
    await import('../../queue');
    await import('../../vault/reader');
    await import('../../logger');

    assertNoUnstructuredConsoleOutput();
  });

  it('console.log の非構造化出力を検出できる（検証用）', () => {
    // テスト自体の信頼性を確認: 非構造化ログを意図的に出力
    capturedCalls.push({
      method: 'log',
      args: ['これは非構造化ログです'],
      stack: 'at Object.<anonymous> (src/some-module.ts:10:5)',
    });

    expect(() => assertNoUnstructuredConsoleOutput()).toThrow(
      '非構造化 console 出力を 1 件検出',
    );
  });

  it('console.warn の非構造化出力を検出できる（検証用）', () => {
    capturedCalls.push({
      method: 'warn',
      args: ['非構造化 warn'],
      stack: 'at Object.<anonymous> (src/some-module.ts:10:5)',
    });

    expect(() => assertNoUnstructuredConsoleOutput()).toThrow(
      '非構造化 console 出力を 1 件検出',
    );
  });

  it('console.error の非構造化出力を検出できる（検証用）', () => {
    capturedCalls.push({
      method: 'error',
      args: ['非構造化 error'],
      stack: 'at Object.<anonymous> (src/some-module.ts:10:5)',
    });

    expect(() => assertNoUnstructuredConsoleOutput()).toThrow(
      '非構造化 console 出力を 1 件検出',
    );
  });

  it('logger フォーマットの出力は許可される（検証用）', () => {
    capturedCalls.push({
      method: 'log',
      args: ['[2024-01-01T00:00:00.000Z] [INFO] [test] test message'],
      stack: 'at Object.<anonymous> (src/some-module.ts:10:5)',
    });

    expect(() => assertNoUnstructuredConsoleOutput()).not.toThrow();
  });

  it('許可リストのモジュールからの出力は許可される（検証用）', () => {
    for (const file of ALLOWED_FILES) {
      capturedCalls.push({
        method: 'log',
        args: ['非構造化だが許可リスト対象'],
        stack: `at Object.<anonymous> (${file}:10:5)`,
      });
    }

    expect(() => assertNoUnstructuredConsoleOutput()).not.toThrow();
  });

  it('JSON フォーマットの logger 出力も許可される（検証用）', () => {
    capturedCalls.push({
      method: 'log',
      args: ['{"ts":"2024-01-01T00:00:00.000Z","level":"INFO","module":"test","msg":"hello"}'],
      stack: 'at Object.<anonymous> (src/some-module.ts:10:5)',
    });

    expect(() => assertNoUnstructuredConsoleOutput()).not.toThrow();
  });
});
