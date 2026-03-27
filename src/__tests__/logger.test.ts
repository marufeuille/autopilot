import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logInfo, logWarn, logError, createCommandLogger } from '../logger';

describe('logger', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  const originalEnv = process.env.LOG_FORMAT;

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    delete process.env.LOG_FORMAT;
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
    if (originalEnv !== undefined) {
      process.env.LOG_FORMAT = originalEnv;
    } else {
      delete process.env.LOG_FORMAT;
    }
  });

  describe('pretty format (default)', () => {
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

      it('デフォルトの module が [app] で出力される', () => {
        logInfo('テスト');

        const output = consoleSpy.log.mock.calls[0][0] as string;
        expect(output).toContain('[app]');
      });

      it('module を指定すると [module] で出力される', () => {
        logInfo('テスト', { module: 'runner' });

        const output = consoleSpy.log.mock.calls[0][0] as string;
        expect(output).toContain('[runner]');
        // module はコンテキスト部分には出力されない
        expect(output).not.toContain('module=');
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

      it('pretty 形式が [timestamp] [LEVEL] [module] message {context} の形式になる', () => {
        logInfo('メッセージ', { module: 'runner', command: 'fix', phase: 'start' });

        const output = consoleSpy.log.mock.calls[0][0] as string;
        // [timestamp] [INFO] [runner] メッセージ {cmd=fix, phase=start}
        expect(output).toMatch(
          /\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[INFO\] \[runner\] メッセージ \{cmd=fix, phase=start\}/,
        );
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
  });

  describe('JSON format (LOG_FORMAT=json)', () => {
    beforeEach(() => {
      process.env.LOG_FORMAT = 'json';
    });

    it('logInfo が JSON 形式で出力される', () => {
      logInfo('テストメッセージ', { module: 'runner', command: 'fix', phase: 'start' });

      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      const output = consoleSpy.log.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(parsed.level).toBe('INFO');
      expect(parsed.module).toBe('runner');
      expect(parsed.msg).toBe('テストメッセージ');
      expect(parsed.command).toBe('fix');
      expect(parsed.phase).toBe('start');
    });

    it('logWarn が JSON 形式で出力される', () => {
      logWarn('警告', { module: 'ci' });

      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(consoleSpy.warn.mock.calls[0][0] as string);
      expect(parsed.level).toBe('WARN');
      expect(parsed.module).toBe('ci');
      expect(parsed.msg).toBe('警告');
    });

    it('logError が JSON 形式で出力される', () => {
      logError('エラー', { module: 'pipeline' });

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(consoleSpy.error.mock.calls[0][0] as string);
      expect(parsed.level).toBe('ERROR');
      expect(parsed.module).toBe('pipeline');
      expect(parsed.msg).toBe('エラー');
    });

    it('module 未指定時はデフォルト app が使われる', () => {
      logInfo('テスト');

      const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string);
      expect(parsed.module).toBe('app');
    });

    it('JSON にコンテキストの全フィールドが含まれる', () => {
      logInfo('テスト', { module: 'runner', command: 'fix', userId: 'U123', slug: 'my-slug' });

      const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string);
      expect(parsed.command).toBe('fix');
      expect(parsed.userId).toBe('U123');
      expect(parsed.slug).toBe('my-slug');
      // module はトップレベルに存在し、コンテキスト側には重複しない
      expect(parsed.module).toBe('runner');
    });
  });

  describe('LOG_FORMAT=pretty は pretty 形式と同じ', () => {
    it('LOG_FORMAT=pretty 設定時は pretty 形式で出力される', () => {
      process.env.LOG_FORMAT = 'pretty';
      logInfo('テスト', { module: 'runner' });

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('[runner]');
      expect(output).toContain('[INFO]');
      // JSON ではないことを確認
      expect(() => JSON.parse(output)).toThrow();
    });
  });

  describe('createCommandLogger', () => {
    it('後方互換: オブジェクトを渡すとベースコンテキストが自動付与される', () => {
      const log = createCommandLogger({ command: 'fix', threadTs: '1111.2222' });

      log.info('テスト', { phase: 'start' });

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('cmd=fix');
      expect(output).toContain('thread=1111.2222');
      expect(output).toContain('phase=start');
      // module 未指定なのでデフォルト app
      expect(output).toContain('[app]');
    });

    it('新形式: module を第1引数で指定できる', () => {
      const log = createCommandLogger('runner', { command: 'fix' });

      log.info('テスト', { phase: 'start' });

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('[runner]');
      expect(output).toContain('cmd=fix');
      expect(output).toContain('phase=start');
    });

    it('新形式: baseContext 省略可能', () => {
      const log = createCommandLogger('runner');

      log.info('テスト');

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('[runner]');
    });

    it('後方互換: オブジェクトに module を含められる', () => {
      const log = createCommandLogger({ command: 'fix', module: 'slack' });

      log.info('テスト');

      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(output).toContain('[slack]');
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

    it('JSON 形式でも module が正しく出力される', () => {
      process.env.LOG_FORMAT = 'json';
      const log = createCommandLogger('runner', { command: 'fix' });

      log.info('テスト');

      const parsed = JSON.parse(consoleSpy.log.mock.calls[0][0] as string);
      expect(parsed.module).toBe('runner');
      expect(parsed.command).toBe('fix');
    });
  });
});
