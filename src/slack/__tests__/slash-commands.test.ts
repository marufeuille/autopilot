import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseCommand,
  isKnownSubcommand,
  buildHelpMessage,
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

describe('isKnownSubcommand', () => {
  it('retryは既知のサブコマンド', () => {
    expect(isKnownSubcommand('retry')).toBe(true);
  });

  it('statusは既知のサブコマンド', () => {
    expect(isKnownSubcommand('status')).toBe(true);
  });

  it('helpは既知のサブコマンド', () => {
    expect(isKnownSubcommand('help')).toBe(true);
  });

  it('storyは既知のサブコマンド', () => {
    expect(isKnownSubcommand('story')).toBe(true);
  });

  it('fixは既知のサブコマンド', () => {
    expect(isKnownSubcommand('fix')).toBe(true);
  });

  it('unknownは既知でない', () => {
    expect(isKnownSubcommand('unknown')).toBe(false);
  });

  it('空文字列は既知でない', () => {
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

describe('registerSlashCommands ルーティング', () => {
  let registeredHandler: (args: { command: { text: string }; ack: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> }) => Promise<void>;
  let mockApp: { command: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    clearSubcommands();
    mockApp = {
      command: vi.fn((name: string, handler: typeof registeredHandler) => {
        registeredHandler = handler;
      }),
    };
    registerSlashCommands(mockApp as any);
  });

  it('/ap help でヘルプメッセージが ack() 経由で返る', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: 'help' }, ack, respond });

    expect(ack).toHaveBeenCalledWith(buildHelpMessage());
    expect(respond).not.toHaveBeenCalled();
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

  it('登録済みサブコマンドは ack() 後に handler が呼ばれる', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerSubcommand('status', handler);

    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: 'status' }, ack, respond });

    expect(ack).toHaveBeenCalledWith();
    expect(handler).toHaveBeenCalledWith([], expect.any(Function));
  });

  it('既知だがハンドラー未登録のサブコマンドは準備中メッセージが返る', async () => {
    // story は KNOWN_SUBCOMMANDS に含まれるがハンドラー未登録
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    await registeredHandler({ command: { text: 'story テスト' }, ack, respond });

    expect(ack).toHaveBeenCalledWith();
    expect(respond).toHaveBeenCalledWith(expect.stringContaining('準備中'));
  });
});
