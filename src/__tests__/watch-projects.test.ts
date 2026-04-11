import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config.watchProjects', () => {
  const origWatchProject = process.env.WATCH_PROJECT;

  afterEach(() => {
    vi.resetModules();
    if (origWatchProject !== undefined) {
      process.env.WATCH_PROJECT = origWatchProject;
    } else {
      delete process.env.WATCH_PROJECT;
    }
  });

  async function loadConfig() {
    const mod = await import('../config');
    return mod.config;
  }

  it('カンマ区切りで複数プロジェクトをパースする', async () => {
    process.env.WATCH_PROJECT = 'stash,hoge';
    const config = await loadConfig();

    expect(config.watchProjects).toEqual(['stash', 'hoge']);
  });

  it('前後の空白をトリムする', async () => {
    process.env.WATCH_PROJECT = ' stash , hoge ';
    const config = await loadConfig();

    expect(config.watchProjects).toEqual(['stash', 'hoge']);
  });

  it('空文字列のエントリはフィルタされる', async () => {
    process.env.WATCH_PROJECT = 'stash,,hoge,';
    const config = await loadConfig();

    expect(config.watchProjects).toEqual(['stash', 'hoge']);
  });

  it('単一プロジェクト指定で従来通り動作する', async () => {
    process.env.WATCH_PROJECT = 'stash';
    const config = await loadConfig();

    expect(config.watchProjects).toEqual(['stash']);
  });

  it('watchProject getter が watchProjects[0] を返す', async () => {
    process.env.WATCH_PROJECT = 'stash,hoge';
    const config = await loadConfig();

    expect(config.watchProject).toBe('stash');
  });

  it('単一プロジェクトで watchProject getter が正しく動作する', async () => {
    process.env.WATCH_PROJECT = 'stash';
    const config = await loadConfig();

    expect(config.watchProject).toBe('stash');
  });

  it('未設定時はデフォルト値を返す', async () => {
    delete process.env.WATCH_PROJECT;
    const config = await loadConfig();

    expect(config.watchProjects).toEqual(['claude-workflow-kit']);
    expect(config.watchProject).toBe('claude-workflow-kit');
  });
});
