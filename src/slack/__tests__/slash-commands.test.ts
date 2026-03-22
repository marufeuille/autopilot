import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from '@slack/bolt';
import {
  parseCommand,
  isKnownSubcommand,
  buildHelpMessage,
  sanitizeForMrkdwn,
  registerSubcommand,
  clearSubcommands,
  registerSlashCommands,
} from '../slash-commands';

describe('parseCommand', () => {
  it('空文字列の場合、サブコマンドなし・引数なしを返す', () => {
    expect(parseCommand('')).toEqual({ subcommand: '', args: [] });
  });

  it('空白のみの場合、サブコマンドなし・引数なしを返す', () => {
    expect(parseCommand('   ')).toEqual({ subcommand: '', args: [] });
  });

  it('サブコマンドのみの場合、引数なしを返す', () => {
    expect(parseCommand('status')).toEqual({ subcommand: 'status', args: [] });
  });

  it('サブコマンドと引数1つを正しくパースする', () => {
    expect(parseCommand('retry my-task')).toEqual({
      subcommand: 'retry',
      args: ['my-task'],
    });
  });

  it('サブコマンドと複数引数を正しくパースする', () => {
    expect(parseCommand('retry my-task --force')).toEqual({
      subcommand: 'retry',
      args: ['my-task', '--force'],
    });
  });

  it('先頭・末尾の空白をトリムする', () => {
    expect(parseCommand('  status  ')).toEqual({ subcommand: 'status', args: [] });
  });

  it('連続する空白を正しく処理する', () => {
    expect(parseCommand('retry   my-task')).toEqual({
      subcommand: 'retry',
      args: ['my-task'],
    });
  });

  it('storyサブコマンドと引数をパースする', () => {
    expect(parseCommand('story ユーザー画面を追加')).toEqual({
      subcommand: 'story',
      args: ['ユーザー画面を追加'],
    });
  });

  it('fixサブコマンドと引数をパースする', () => {
    expect(parseCommand('fix ログインが404になる')).toEqual({
      subcommand: 'fix',
      args: ['ログインが404になる'],
    });
  });
});

describe('sanitizeForMrkdwn', () => {
  it('通常の文字列はそのまま返す', () => {
    expect(sanitizeForMrkdwn('hello')).toBe('hello');
  });

  it('<, >, & をエスケープする', () => {
    expect(sanitizeForMrkdwn('<script>&alert</script>')).toBe('&lt;script&gt;&amp;alert&lt;/script&gt;');
  });

  it('@channel, @here, @everyone を無効化する', () => {
    expect(sanitizeForMrkdwn('@channel')).toBe('@ channel');
    expect(sanitizeForMrkdwn('@here')).toBe('@ here');
    expect(sanitizeForMrkdwn('@everyone')).toBe('@ everyone');
  });

  it('@Channel のように大文字混在でも無効化する', () => {
    expect(sanitizeForMrkdwn('@Channel')).toBe('@ Channel');
  });

  it('50文字を超える入力を切り詰める', () => {
    const long = 'a'.repeat(60);
    const result = sanitizeForMrkdwn(long);
    expect(result).toBe('a'.repeat(50) + '…');
  });

  it('50文字ちょうどの入力は切り詰めない', () => {
    const exact = 'a'.repeat(50);
    expect(sanitizeForMrkdwn(exact)).toBe(exact);
  });
});

describe('isKnownSubcommand', () => {
  beforeEach(() => {
    clearSubcommands();
  });

  it('登録済みサブコマンドはtrueを返す', () => {
    registerSubcommand('status', vi.fn().mockResolvedValue(undefined));
    expect(isKnownSubcommand('status')).toBe(true);
  });

  it('未登録サブコマンドはfalseを返す', () => {
    expect(isKnownSubcommand('unknown')).toBe(false);
  });

  it('空文字列はfalseを返す', () => {
    expect(isKnownSubcommand('')).toBe(false);
  });
});

describe('buildHelpMessage', () => {
  it('statusコマンドの説明を含む', () => {
    const msg = buildHelpMessage();
    expect(msg).toContain('/ap status');
  });

  it('retryコマンドの説明を含む', () => {
    const msg = buildHelpMessage();
    expect(msg).toContain('/ap retry');
  });

  it('helpコマンドの説明を含む', () => {
    const msg = buildHelpMessage();
    expect(msg).toContain('/ap help');
  });

  it('storyコマンドの説明を含む', () => {
    const msg = buildHelpMessage();
    expect(msg).toContain('/ap story');
  });

  it('fixコマンドの説明を含む', () => {
    const msg = buildHelpMessage();
    expect(msg).toContain('/ap fix');
  });
});

/** registerSlashCommands が使う App のメソッドだけを持つ部分型 */
type SlackAppForTest = Pick<App, 'command'>;

describe('registerSlashCommands ルーティング', () => {
  let registeredHandler: (args: { command: { text: string }; ack: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> }) => Promise<void>;
  let mockApp: SlackAppForTest;

  beforeEach(() => {
    clearSubcommands();
    mockApp = {
      command: vi.fn(((_name: string, handler: typeof registeredHandler) => {
        registeredHandler = handler;
      }) as App['command']),
    };
    registerSlashCommands(mockApp as App);
  });

  it('/ap help でヘルプメッセージが respond() 経由で返る', async () => {
    const helpHandler = vi.fn().mockResolvedValue(undefined);
    registerSubcommand('help', helpHandler);

    // ハンドラー登録後に再登録してハンドラーマップを反映
    registerSlashCommands(mockApp as App);

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: 'help' }, ack, respond });

    expect(ack).toHaveBeenCalledWith();
    expect(helpHandler).toHaveBeenCalledWith([], expect.any(Function));
  });

  it('サブコマンドなしでヘルプメッセージが返る', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: '' }, ack, respond });

    expect(ack).toHaveBeenCalledWith(buildHelpMessage());
    expect(respond).not.toHaveBeenCalled();
  });

  it('未知のサブコマンドでエラーメッセージが返る', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: 'foobar' }, ack, respond });

    expect(ack).toHaveBeenCalledWith(expect.stringContaining('不明なサブコマンド'));
    expect(ack).toHaveBeenCalledWith(expect.stringContaining('foobar'));
    expect(respond).not.toHaveBeenCalled();
  });

  it('未知のサブコマンドにメンション記法が含まれる場合サニタイズされる', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: '@channel' }, ack, respond });

    const msg = ack.mock.calls[0][0] as string;
    expect(msg).toContain('@ channel');
    expect(msg).not.toContain('@channel');
  });

  it('未知のサブコマンドにHTML特殊文字が含まれる場合エスケープされる', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: '<script>' }, ack, respond });

    const msg = ack.mock.calls[0][0] as string;
    expect(msg).toContain('&lt;script&gt;');
    expect(msg).not.toContain('<script>');
  });

  it('登録済みサブコマンドは ack() 後に handler が呼ばれる', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerSubcommand('status', handler);

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: 'status' }, ack, respond });

    expect(ack).toHaveBeenCalledWith();
    expect(handler).toHaveBeenCalledWith([], expect.any(Function));
  });

  it('ハンドラー未登録のサブコマンドはエラーメッセージが返る', async () => {
    // 'story' はハンドラー未登録
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: 'story テスト' }, ack, respond });

    expect(ack).toHaveBeenCalledWith(expect.stringContaining('不明なサブコマンド'));
    expect(respond).not.toHaveBeenCalled();
  });
});
