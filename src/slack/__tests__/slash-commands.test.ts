import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  isKnownSubcommand,
  buildHelpMessage,
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
});

describe('isKnownSubcommand', () => {
  it('retryは既知のサブコマンド', () => {
    expect(isKnownSubcommand('retry')).toBe(true);
  });

  it('statusは既知のサブコマンド', () => {
    expect(isKnownSubcommand('status')).toBe(true);
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
});
