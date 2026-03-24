import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRepoPath } from '../config';

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
