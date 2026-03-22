import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logInfo, logWarn, logError, createCommandLogger } from '../logger';

describe('logger', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });

  describe('logInfo', () => {
    it('info レベルのログを出力する', () => {
      logInfo('テストメッセージ');

      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('[INFO]');
      expect(output).toContain('テストメッセージ');
    });

    it('タイムスタンプが含まれる', () => {
      logInfo('テスト');

      const output = consoleSpy.log.mock.calls[0][0] as string;
      // ISO 8601 形式のタイムスタンプ
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('コンテキスト情報がフォーマットされる', () => {
      logInfo('テスト', {
        command: 'fix',
        userId: 'U123',
        phase: 'command_received',
        threadTs: '1111.2222',
      });

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('cmd=fix');
      expect(output).toContain('user=U123');
      expect(output).toContain('phase=command_received');
      expect(output).toContain('thread=1111.2222');
    });

    it('追加のコンテキストフィールドも出力される', () => {
      logInfo('テスト', { command: 'fix', slug: 'fix-login-error' });

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('slug=fix-login-error');
    });
  });

  describe('logWarn', () => {
    it('warn レベルのログを出力する', () => {
      logWarn('警告メッセージ');

      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      const output = consoleSpy.warn.mock.calls[0][0] as string;
      expect(output).toContain('[WARN]');
      expect(output).toContain('警告メッセージ');
    });
  });

  describe('logError', () => {
    it('error レベルのログを出力する', () => {
      logError('エラーメッセージ');

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      const output = consoleSpy.error.mock.calls[0][0] as string;
      expect(output).toContain('[ERROR]');
      expect(output).toContain('エラーメッセージ');
    });

    it('Error オブジェクトのスタックトレースが含まれる', () => {
      const err = new Error('テストエラー');
      logError('エラー発生', {}, err);

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      const errorDetail = consoleSpy.error.mock.calls[0][1] as any;
      expect(errorDetail.error).toBe('テストエラー');
      expect(errorDetail.stack).toBeDefined();
      expect(errorDetail.stack).toContain('テストエラー');
    });

    it('非Errorオブジェクトもログに含める', () => {
      logError('エラー発生', {}, 'string error');

      const errorDetail = consoleSpy.error.mock.calls[0][1] as any;
      expect(errorDetail.error).toBe('string error');
    });

    it('errorオブジェクトなしでも動作する', () => {
      logError('エラーメッセージのみ', { command: 'fix' });

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      // 第2引数（エラー詳細）がないことを確認
      expect(consoleSpy.error.mock.calls[0]).toHaveLength(1);
    });
  });

  describe('createCommandLogger', () => {
    it('ベースコンテキストが自動付与される', () => {
      const log = createCommandLogger({ command: 'fix', threadTs: '1111.2222' });

      log.info('テスト', { phase: 'start' });

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('cmd=fix');
      expect(output).toContain('thread=1111.2222');
      expect(output).toContain('phase=start');
    });

    it('warn レベルが使える', () => {
      const log = createCommandLogger({ command: 'fix' });
      log.warn('警告');

      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
    });

    it('error レベルが使える', () => {
      const log = createCommandLogger({ command: 'fix' });
      const err = new Error('test');
      log.error('エラー', {}, err);

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    it('追加コンテキストでベースコンテキストをオーバーライドできる', () => {
      const log = createCommandLogger({ command: 'fix', phase: 'default' });
      log.info('テスト', { phase: 'override' });

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('phase=override');
      expect(output).not.toContain('phase=default');
    });
  });
});
