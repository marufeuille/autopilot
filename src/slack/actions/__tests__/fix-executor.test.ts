import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  executeFixInternal,
  buildFixExecutionPrompt,
  withTimeout,
  classifyExecutionError,
  sanitizeSlackOutput,
  FixExecutionTimeoutError,
  type FixExecutionDeps,
} from '../fix-executor';
import {
  interactiveSessionManager,
  type InteractiveSession,
} from '../../interactive-session';
import type { ParsedFixDraft } from '../fix-approval';

function makeParsedDraft(overrides: Partial<ParsedFixDraft> = {}): ParsedFixDraft {
  return {
    title: 'fix: Login 404 Error',
    analysis: 'ルーティング設定の不備',
    approach: 'ルーティングを修正する',
    acceptance: '- [ ] ログインが正常に動作する',
    impact: '認証モジュール',
    ...overrides,
  };
}

function makeSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    threadTs: '1234567890.123456',
    channelId: 'C_TEST_CHANNEL',
    type: 'fix',
    phase: 'executing',
    description: 'ログインで404エラー',
    conversationHistory: [
      { role: 'user', content: 'ログインで404エラー' },
      { role: 'assistant', content: '### タイトル\nfix: Login 404 Error' },
    ],
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<FixExecutionDeps> = {}): FixExecutionDeps {
  return {
    postMessage: vi.fn().mockResolvedValue({ ts: '9999999999.999999' }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    runFixAgent: vi.fn().mockResolvedValue('### 修正サマリー\nルーティングを修正しました\n\n### 変更ファイル\n- src/router.ts: ルート追加\n\n### 確認結果\n全条件クリア'),
    ...overrides,
  };
}

describe('buildFixExecutionPrompt', () => {
  it('パース結果からfix実行プロンプトを構築する', () => {
    const parsed = makeParsedDraft();
    const prompt = buildFixExecutionPrompt(parsed, 'fix-login-404-error');

    expect(prompt).toContain('fix: Login 404 Error');
    expect(prompt).toContain('ルーティング設定の不備');
    expect(prompt).toContain('ルーティングを修正する');
    expect(prompt).toContain('ログインが正常に動作する');
    expect(prompt).toContain('認証モジュール');
  });
});

describe('withTimeout', () => {
  it('タイムアウト前に完了すれば結果を返す', async () => {
    const promise = Promise.resolve('success');
    const result = await withTimeout(promise, 5000);
    expect(result).toBe('success');
  });

  it('タイムアウトするとFixExecutionTimeoutErrorをスローする', async () => {
    const promise = new Promise<string>(() => {}); // never resolves

    await expect(
      withTimeout(promise, 10, 'テストタイムアウト'),
    ).rejects.toThrow(FixExecutionTimeoutError);
  });

  it('元のPromiseがエラーを投げた場合はそのエラーを伝播する', async () => {
    const promise = Promise.reject(new Error('original error'));

    await expect(
      withTimeout(promise, 5000),
    ).rejects.toThrow('original error');
  });
});

describe('classifyExecutionError', () => {
  it('FixExecutionTimeoutErrorをtimeoutに分類する', () => {
    const error = new FixExecutionTimeoutError('timeout', 300000);
    const result = classifyExecutionError(error);

    expect(result.errorType).toBe('timeout');
    expect(result.userMessage).toContain('タイムアウト');
    expect(result.userMessage).toContain('5分');
  });

  it('rate limit エラーをclaude_apiに分類する', () => {
    const error = new Error('Rate limit exceeded');
    const result = classifyExecutionError(error);

    expect(result.errorType).toBe('claude_api');
    expect(result.userMessage).toContain('Claude API');
  });

  it('overloaded エラーをclaude_apiに分類する', () => {
    const error = new Error('Service overloaded, please retry');
    const result = classifyExecutionError(error);

    expect(result.errorType).toBe('claude_api');
  });

  it('anthropic キーワードを含むエラーをclaude_apiに分類する', () => {
    const error = new Error('Anthropic API connection failed');
    const result = classifyExecutionError(error);

    expect(result.errorType).toBe('claude_api');
  });

  it('claude キーワードを含むエラーをclaude_apiに分類する', () => {
    const error = new Error('Claude model not available');
    const result = classifyExecutionError(error);

    expect(result.errorType).toBe('claude_api');
  });

  it('status 429 のエラーをclaude_apiに分類する', () => {
    const error = new Error('Too many requests') as any;
    error.status = 429;
    const result = classifyExecutionError(error);

    expect(result.errorType).toBe('claude_api');
  });

  it('汎用的な "api" や "token" を含むエラーは誤分類しない', () => {
    // "Invalid API key" のような無関係なエラーは unknown になるべき
    const apiError = new Error('Invalid API key for external service');
    expect(classifyExecutionError(apiError).errorType).toBe('unknown');

    // "token expired" のような認証トークンエラーも unknown
    const tokenError = new Error('Session token expired');
    expect(classifyExecutionError(tokenError).errorType).toBe('unknown');
  });

  it('不明なエラーをunknownに分類する', () => {
    const error = new Error('Something went wrong');
    const result = classifyExecutionError(error);

    expect(result.errorType).toBe('unknown');
    expect(result.userMessage).toContain('Something went wrong');
  });

  it('非Errorオブジェクトもunknownに分類する', () => {
    const result = classifyExecutionError('string error');

    expect(result.errorType).toBe('unknown');
    expect(result.userMessage).toContain('string error');
  });
});

describe('FixExecutionTimeoutError', () => {
  it('timeoutMsを保持する', () => {
    const error = new FixExecutionTimeoutError('test', 60000);

    expect(error.name).toBe('FixExecutionTimeoutError');
    expect(error.timeoutMs).toBe(60000);
    expect(error.message).toBe('test');
  });
});

describe('sanitizeSlackOutput', () => {
  it('@here, @channel, @everyone を無効化する', () => {
    const input = 'Hello @here and @channel and @everyone!';
    const result = sanitizeSlackOutput(input);

    expect(result).toBe('Hello `@here` and `@channel` and `@everyone`!');
  });

  it('Slack 特殊メンション構文 (<!here> 等) を無効化する', () => {
    const input = 'Alert <!here> and <!channel|channel> and <!everyone>';
    const result = sanitizeSlackOutput(input);

    expect(result).toContain('`@here`');
    expect(result).toContain('`@channel`');
    expect(result).toContain('`@everyone`');
  });

  it('ユーザーメンション (<@U...>) を無効化する', () => {
    const input = 'Check with <@U1234ABCD> and <@U9876ZYXW>';
    const result = sanitizeSlackOutput(input);

    expect(result).toBe('Check with `@U1234ABCD` and `@U9876ZYXW`');
  });

  it('通常のテキストはそのまま返す', () => {
    const input = 'Normal text with *bold* and `code`';
    expect(sanitizeSlackOutput(input)).toBe(input);
  });
});

describe('executeFixInternal', () => {
  const threadTs = '1234567890.123456';
  const channelId = 'C_TEST_CHANNEL';
  const slug = 'fix-login-404-error';
  const userId = 'U_TEST_USER';

  beforeEach(() => {
    vi.clearAllMocks();
    const mgr = interactiveSessionManager as any;
    mgr.sessions?.clear?.();
  });

  it('正常系: 修正が実行され結果がスレッドに投稿される', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps();

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
    );

    expect(result.success).toBe(true);
    expect(result.summary).toContain('修正サマリー');

    // 進捗メッセージが投稿される
    expect(deps.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: channelId,
        thread_ts: threadTs,
        text: expect.stringContaining('修正を実行中です'),
      }),
    );

    // Claude Agent が呼ばれる（prompt と AbortSignal の2引数）
    expect(deps.runFixAgent).toHaveBeenCalledTimes(1);
    expect(deps.runFixAgent).toHaveBeenCalledWith(
      expect.stringContaining('fix: Login 404 Error'),
      expect.any(AbortSignal),
    );

    // 進捗メッセージが完了に更新される
    expect(deps.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('修正が完了しました'),
      }),
    );

    // 結果がスレッドに投稿される
    const postCalls = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const resultPost = postCalls[postCalls.length - 1][0];
    expect(resultPost.text).toContain('修正が完了しました');
    expect(resultPost.text).toContain(slug);
    expect(resultPost.thread_ts).toBe(threadTs);

    // phaseがcompletedに遷移
    expect(interactiveSessionManager.getSession(threadTs)?.phase).toBe('completed');
  });

  it('Claude APIエラー時: エラーメッセージがスレッドに投稿され例外で落ちない', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps({
      runFixAgent: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
    });

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('claude_api');
    expect(result.error).toContain('rate limit');

    // 進捗メッセージがエラーに更新される
    expect(deps.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('エラーが発生しました'),
      }),
    );

    // エラーメッセージがスレッドに投稿される
    const postCalls = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const errorPost = postCalls[postCalls.length - 1][0];
    expect(errorPost.text).toContain('Claude API');
    expect(errorPost.thread_ts).toBe(threadTs);
  });

  it('タイムアウト時: タイムアウトメッセージがスレッドに投稿され例外で落ちない', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps({
      runFixAgent: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
    });

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
      50, // 50ms timeout for test
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('timeout');

    // エラーメッセージがスレッドに投稿される
    const postCalls = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const errorPost = postCalls[postCalls.length - 1][0];
    expect(errorPost.text).toContain('タイムアウト');
    expect(errorPost.thread_ts).toBe(threadTs);
  });

  it('不明なエラー時: 汎用エラーメッセージがスレッドに投稿される', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps({
      runFixAgent: vi.fn().mockRejectedValue(new Error('Unknown failure')),
    });

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('unknown');

    const postCalls = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const errorPost = postCalls[postCalls.length - 1][0];
    expect(errorPost.text).toContain('エラーが発生しました');
    expect(errorPost.text).toContain('Unknown failure');
  });

  it('進捗メッセージのtsが取得できない場合でも正常に動作する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps({
      postMessage: vi.fn()
        .mockResolvedValueOnce({ ts: undefined }) // 進捗メッセージのts取得失敗
        .mockResolvedValueOnce({ ts: '8888888888.888888' }), // 結果投稿
    });

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
    );

    expect(result.success).toBe(true);
    // updateMessageは呼ばれない（tsが取得できなかったため）
    expect(deps.updateMessage).not.toHaveBeenCalled();
  });

  it('userIdが未指定でも正常に動作する', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps();

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps,
    );

    expect(result.success).toBe(true);
  });

  it('エラー時にSlack API呼び出しが失敗しても例外で落ちない', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps({
      runFixAgent: vi.fn().mockRejectedValue(new Error('Agent failed')),
      updateMessage: vi.fn().mockRejectedValue(new Error('Slack API down')),
      postMessage: vi.fn()
        .mockResolvedValueOnce({ ts: '9999999999.999999' }) // 進捗メッセージ
        .mockRejectedValueOnce(new Error('Slack API down')),  // エラーメッセージ投稿失敗
    });

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
    );

    // Slack API が失敗しても結果は返る
    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent failed');
    expect(result.errorType).toBe('unknown');
  });

  it('修正結果のSlackメンションがサニタイズされる', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();
    const deps = createMockDeps({
      runFixAgent: vi.fn().mockResolvedValue('修正完了 @here <@U1234> <!channel>'),
    });

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
    );

    expect(result.success).toBe(true);

    // 結果投稿のテキストにサニタイズ済みの内容が含まれる
    const postCalls = (deps.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const resultPost = postCalls[postCalls.length - 1][0];
    // バッククォートで囲まれていない生の @here が含まれないことを確認
    expect(resultPost.text).not.toMatch(/(?<!`)@here(?!`)/);
    expect(resultPost.text).toContain('`@here`');
    expect(resultPost.text).toContain('`@U1234`');
    expect(resultPost.text).toContain('`@channel`');
  });

  it('withTimeoutにAbortControllerが渡される', async () => {
    const session = makeSession();
    interactiveSessionManager.startSession(session);
    const parsed = makeParsedDraft();

    // signal が渡されることを確認
    const runFixAgent = vi.fn().mockImplementation((_prompt: string, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve('### 修正サマリー\n完了');
    });
    const deps = createMockDeps({ runFixAgent });

    const result = await executeFixInternal(
      threadTs, channelId, parsed, slug, deps, userId,
    );

    expect(result.success).toBe(true);
    expect(runFixAgent).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal));
  });
});
