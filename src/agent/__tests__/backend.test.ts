import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeBackend, AgentBackend, AgentRunOptions } from '../backend';

// Claude Code SDK（query）をモック
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// logger をモック（副作用を防ぐ）
vi.mock('../../logger', () => ({
  createCommandLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

const mockedQuery = vi.mocked(query);

/**
 * async generator ヘルパー: メッセージ配列を AsyncIterable に変換する
 */
async function* fakeStream(messages: unknown[]): AsyncIterable<unknown> {
  for (const m of messages) {
    yield m;
  }
}

describe('AgentBackend interface', () => {
  it('ClaudeBackend は AgentBackend を満たす', () => {
    const backend: AgentBackend = new ClaudeBackend();
    expect(backend).toBeDefined();
    expect(typeof backend.run).toBe('function');
  });
});

describe('ClaudeBackend', () => {
  let backend: ClaudeBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new ClaudeBackend();
  });

  it('assistant メッセージのテキストを結合して返す', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([
        {
          type: 'assistant',
          message: {
            content: [{ text: 'Hello' }, { text: ' World' }],
          },
        },
        { type: 'result', subtype: 'success' },
      ]) as ReturnType<typeof query>,
    );

    const result = await backend.run('test prompt', { cwd: '/tmp' });
    expect(result).toBe('Hello\n World');
  });

  it('result メッセージの result フィールドも取得する', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([
        {
          type: 'assistant',
          message: { content: [{ text: 'step output' }] },
        },
        { type: 'result', subtype: 'success', result: 'final answer' },
      ]) as ReturnType<typeof query>,
    );

    const result = await backend.run('test', { cwd: '/tmp' });
    expect(result).toBe('step output\nfinal answer');
  });

  it('空のストリームでは空文字列を返す', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([
        { type: 'result', subtype: 'success' },
      ]) as ReturnType<typeof query>,
    );

    const result = await backend.run('test', { cwd: '/tmp' });
    expect(result).toBe('');
  });

  it('query に正しいオプションを渡す（デフォルトは bypassPermissions）', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([{ type: 'result', subtype: 'success' }]) as ReturnType<typeof query>,
    );

    await backend.run('my prompt', { cwd: '/workspace' });

    expect(mockedQuery).toHaveBeenCalledWith({
      prompt: 'my prompt',
      options: {
        cwd: '/workspace',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
      },
    });
  });

  it('allowedTools を指定した場合はそれが使われる', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([{ type: 'result', subtype: 'success' }]) as ReturnType<typeof query>,
    );

    await backend.run('prompt', {
      cwd: '/workspace',
      allowedTools: ['Read', 'Grep'],
    });

    expect(mockedQuery).toHaveBeenCalledWith({
      prompt: 'prompt',
      options: {
        cwd: '/workspace',
        allowedTools: ['Read', 'Grep'],
        permissionMode: 'bypassPermissions',
      },
    });
  });

  it('permissionMode を明示的に default に指定した場合はそれが使われる', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([{ type: 'result', subtype: 'success' }]) as ReturnType<typeof query>,
    );

    await backend.run('prompt', {
      cwd: '/workspace',
      permissionMode: 'default',
    });

    expect(mockedQuery).toHaveBeenCalledWith({
      prompt: 'prompt',
      options: {
        cwd: '/workspace',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: 'default',
      },
    });
  });

  it('content が空の assistant メッセージをスキップする', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([
        { type: 'assistant', message: { content: [] } },
        { type: 'assistant', message: null },
        { type: 'assistant' },
        {
          type: 'assistant',
          message: { content: [{ text: 'actual output' }] },
        },
        { type: 'result', subtype: 'success' },
      ]) as ReturnType<typeof query>,
    );

    const result = await backend.run('test', { cwd: '/tmp' });
    expect(result).toBe('actual output');
  });

  it('error subtype の result メッセージでは result フィールドを取得しない', async () => {
    mockedQuery.mockReturnValue(
      fakeStream([
        { type: 'result', subtype: 'error', result: 'should not appear' },
      ]) as ReturnType<typeof query>,
    );

    const result = await backend.run('test', { cwd: '/tmp' });
    expect(result).toBe('');
  });

  it('query が例外を throw した場合はログ出力して再 throw する', async () => {
    const networkError = new Error('Network connection failed');
    mockedQuery.mockReturnValue(
      (async function* () {
        throw networkError;
      })() as ReturnType<typeof query>,
    );

    await expect(backend.run('test', { cwd: '/tmp' })).rejects.toThrow('Network connection failed');
  });

  it('query が同期的に throw した場合もログ出力して再 throw する', async () => {
    mockedQuery.mockImplementation(() => {
      throw new Error('Authentication failed');
    });

    await expect(backend.run('test', { cwd: '/tmp' })).rejects.toThrow('Authentication failed');
  });
});

describe('AgentRunOptions', () => {
  it('cwd は必須、allowedTools はオプショナル', () => {
    // 型レベルの検証: コンパイルが通ることが確認
    const minimal: AgentRunOptions = { cwd: '/tmp' };
    const full: AgentRunOptions = { cwd: '/tmp', allowedTools: ['Bash'], permissionMode: 'bypassPermissions' };
    expect(minimal.cwd).toBe('/tmp');
    expect(full.allowedTools).toEqual(['Bash']);
    expect(full.permissionMode).toBe('bypassPermissions');
  });
});
