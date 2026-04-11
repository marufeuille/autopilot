import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRepoPath, validateAgentBackends, config } from '../config';
import type { AgentBackendsConfig } from '../config';

describe('resolveRepoPath', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.REPO_BASE_PATH;
  });

  afterEach(() => {
    process.env.HOME = origEnv.HOME;
    if (origEnv.REPO_BASE_PATH !== undefined) {
      process.env.REPO_BASE_PATH = origEnv.REPO_BASE_PATH;
    } else {
      delete process.env.REPO_BASE_PATH;
    }
  });

  it('REPO_BASE_PATH が設定されている場合、それをベースディレクトリとして使用する', () => {
    process.env.REPO_BASE_PATH = '/workspace';
    expect(resolveRepoPath('my-project')).toBe('/workspace/my-project');
  });

  it('REPO_BASE_PATH が設定されている場合、HOME より優先される', () => {
    process.env.REPO_BASE_PATH = '/workspace';
    process.env.HOME = '/home/user';
    expect(resolveRepoPath('my-project')).toBe('/workspace/my-project');
  });

  it('HOME のみ設定されている場合、${HOME}/dev をベースディレクトリとして使用する', () => {
    process.env.HOME = '/home/user';
    expect(resolveRepoPath('my-project')).toBe('/home/user/dev/my-project');
  });

  it('HOME も REPO_BASE_PATH も未設定の場合、エラーを投げる', () => {
    delete process.env.HOME;
    expect(() => resolveRepoPath('my-project')).toThrow(
      'Cannot resolve repo path: neither REPO_BASE_PATH nor HOME environment variable is set.',
    );
  });
});

describe('validateAgentBackends', () => {
  const allClaude: AgentBackendsConfig = {
    implementation: { type: 'claude' },
    review:         { type: 'claude' },
    planning:       { type: 'claude' },
    fix:            { type: 'claude' },
  };

  it('undefined を渡すとデフォルト値（全 step が claude）を返す', () => {
    expect(validateAgentBackends(undefined)).toEqual(allClaude);
  });

  it('null を渡すとデフォルト値を返す', () => {
    expect(validateAgentBackends(null)).toEqual(allClaude);
  });

  it('全 step を明示的に指定した場合、そのまま返す', () => {
    const input = {
      implementation: { type: 'claude' },
      review:         { type: 'claude' },
      planning:       { type: 'claude' },
      fix:            { type: 'claude' },
    };
    expect(validateAgentBackends(input)).toEqual(allClaude);
  });

  it('一部の step のみ指定した場合、未指定分はデフォルト値で補完される', () => {
    const input = { implementation: { type: 'claude' } };
    expect(validateAgentBackends(input)).toEqual(allClaude);
  });

  it('空オブジェクトを渡すとデフォルト値で補完される', () => {
    expect(validateAgentBackends({})).toEqual(allClaude);
  });

  // --- バリデーションエラー ---

  it('配列を渡すとエラー', () => {
    expect(() => validateAgentBackends([])).toThrow('agentBackends must be an object');
  });

  it('文字列を渡すとエラー', () => {
    expect(() => validateAgentBackends('claude')).toThrow('agentBackends must be an object');
  });

  it('未知の step 名があるとエラー', () => {
    const input = { implementation: { type: 'claude' }, unknown_step: { type: 'claude' } };
    expect(() => validateAgentBackends(input)).toThrow("Unknown agent step: 'unknown_step'");
  });

  it('step の値がオブジェクトでない場合エラー', () => {
    expect(() => validateAgentBackends({ implementation: 'claude' })).toThrow(
      'agentBackends.implementation must be an object',
    );
  });

  it('step の値が null の場合エラー', () => {
    expect(() => validateAgentBackends({ implementation: null })).toThrow(
      'agentBackends.implementation must be an object',
    );
  });

  it('step の値が配列の場合エラー', () => {
    expect(() => validateAgentBackends({ review: [] })).toThrow(
      'agentBackends.review must be an object',
    );
  });

  it('type が未指定の場合エラー', () => {
    expect(() => validateAgentBackends({ fix: {} })).toThrow(
      'agentBackends.fix.type is required',
    );
  });

  it('type が不正な値の場合エラー', () => {
    expect(() => validateAgentBackends({ planning: { type: 'openai' } })).toThrow(
      "agentBackends.planning.type must be one of: claude. Got: 'openai'",
    );
  });

  it('type が数値の場合エラー', () => {
    expect(() => validateAgentBackends({ implementation: { type: 42 } })).toThrow(
      "agentBackends.implementation.type must be one of: claude. Got: '42'",
    );
  });
});

describe('config.agentBackends', () => {
  it('デフォルト値として全 step が claude に設定されている', () => {
    expect(config.agentBackends).toEqual({
      implementation: { type: 'claude' },
      review:         { type: 'claude' },
      planning:       { type: 'claude' },
      fix:            { type: 'claude' },
    });
  });

  it('各 step に個別にアクセスできる', () => {
    expect(config.agentBackends.implementation.type).toBe('claude');
    expect(config.agentBackends.review.type).toBe('claude');
    expect(config.agentBackends.planning.type).toBe('claude');
    expect(config.agentBackends.fix.type).toBe('claude');
  });
});
