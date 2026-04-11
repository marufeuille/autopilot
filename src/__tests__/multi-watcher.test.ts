import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StoryQueueManager } from '../queue/queue-manager';
import type { QueueManagerDeps } from '../queue/queue-manager';
import type { StoryFile, StoryStatus } from '../vault/reader';

function makeStory(slug: string, status: StoryStatus = 'Todo', project = 'test'): StoryFile {
  return {
    filePath: `/vault/Projects/${project}/stories/${slug}.md`,
    project,
    slug,
    status,
    frontmatter: { status },
    content: '',
  };
}

function makeDeps(stories: Record<string, StoryFile> = {}): QueueManagerDeps {
  return {
    readStoryBySlug: vi.fn((slug: string) => {
      const story = stories[slug];
      if (!story) throw new Error(`Story "${slug}" が見つかりません`);
      return story;
    }),
    updateFileStatus: vi.fn(),
  };
}

describe('マルチプロジェクトキュー管理', () => {
  it('プロジェクトごとに独立した Map<string, StoryQueueManager> を生成できる', () => {
    const queueManagers = new Map<string, StoryQueueManager>();
    const projects = ['stash', 'hoge'];

    for (const project of projects) {
      queueManagers.set(
        project,
        new StoryQueueManager(
          makeDeps({
            [`${project}-story`]: makeStory(`${project}-story`, 'Todo', project),
          }),
        ),
      );
    }

    expect(queueManagers.size).toBe(2);
    expect(queueManagers.has('stash')).toBe(true);
    expect(queueManagers.has('hoge')).toBe(true);
  });

  it('各キューが独立して動作する', () => {
    const qmStash = new StoryQueueManager(
      makeDeps({ 'stash-story': makeStory('stash-story', 'Todo', 'stash') }),
    );
    const qmHoge = new StoryQueueManager(
      makeDeps({ 'hoge-story': makeStory('hoge-story', 'Todo', 'hoge') }),
    );

    // 各キューに追加
    qmStash.add('stash-story');
    qmHoge.add('hoge-story');

    expect(qmStash.list()).toHaveLength(1);
    expect(qmStash.list()[0].slug).toBe('stash-story');
    expect(qmHoge.list()).toHaveLength(1);
    expect(qmHoge.list()[0].slug).toBe('hoge-story');
  });

  it('片方のキュー停止がもう一方に影響しない', () => {
    const qmStash = new StoryQueueManager(
      makeDeps({ 'stash-story': makeStory('stash-story', 'Todo', 'stash') }),
    );
    const qmHoge = new StoryQueueManager(
      makeDeps({ 'hoge-story': makeStory('hoge-story', 'Todo', 'hoge') }),
    );

    qmStash.add('stash-story');
    qmHoge.add('hoge-story');

    // stash のキューを停止
    qmStash.pauseQueue();

    // stash は停止中
    expect(qmStash.isQueuePaused).toBe(true);
    expect(qmStash.shift()).toBeUndefined();

    // hoge は影響を受けない
    expect(qmHoge.isQueuePaused).toBe(false);
    expect(qmHoge.shift()).toBeDefined();
  });

  it('プロジェクト間でストーリー slug が重複しても独立して管理される', () => {
    const qmA = new StoryQueueManager(
      makeDeps({ 'shared-story': makeStory('shared-story', 'Todo', 'project-a') }),
    );
    const qmB = new StoryQueueManager(
      makeDeps({ 'shared-story': makeStory('shared-story', 'Todo', 'project-b') }),
    );

    qmA.add('shared-story');
    qmB.add('shared-story');

    expect(qmA.list()).toHaveLength(1);
    expect(qmA.list()[0].project).toBe('project-a');
    expect(qmB.list()).toHaveLength(1);
    expect(qmB.list()[0].project).toBe('project-b');
  });
});

describe('存在しないプロジェクトディレクトリのスキップ', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-watcher-'));
    // stash プロジェクトのみディレクトリを作成
    fs.mkdirSync(path.join(tmpDir, 'Projects', 'stash', 'stories'), { recursive: true });
    // hoge プロジェクトは作成しない
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('存在するプロジェクトのパスは true を返す', () => {
    const storiesPath = path.join(tmpDir, 'Projects', 'stash', 'stories');
    expect(fs.existsSync(storiesPath)).toBe(true);
  });

  it('存在しないプロジェクトのパスは false を返す', () => {
    const storiesPath = path.join(tmpDir, 'Projects', 'hoge', 'stories');
    expect(fs.existsSync(storiesPath)).toBe(false);
  });

  it('存在するプロジェクトのみウォッチャーが起動される（シミュレーション）', () => {
    const projects = ['stash', 'hoge'];
    const watchedProjects: string[] = [];

    for (const project of projects) {
      const storiesPath = path.join(tmpDir, 'Projects', project, 'stories');
      if (!fs.existsSync(storiesPath)) {
        // スキップ（クラッシュしない）
        continue;
      }
      watchedProjects.push(project);
    }

    expect(watchedProjects).toEqual(['stash']);
    expect(watchedProjects).not.toContain('hoge');
  });
});

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

  it('カンマ区切りでプロジェクトごとにキューマネージャーを生成できる', async () => {
    process.env.WATCH_PROJECT = 'stash,hoge';
    const config = await loadConfig();
    const queueManagers = new Map<string, StoryQueueManager>();

    for (const project of config.watchProjects) {
      queueManagers.set(project, new StoryQueueManager());
    }

    expect(queueManagers.size).toBe(2);
    expect(queueManagers.has('stash')).toBe(true);
    expect(queueManagers.has('hoge')).toBe(true);
  });

  it('単一プロジェクトで既存動作が変わらない', async () => {
    process.env.WATCH_PROJECT = 'stash';
    const config = await loadConfig();
    const queueManagers = new Map<string, StoryQueueManager>();

    for (const project of config.watchProjects) {
      queueManagers.set(project, new StoryQueueManager());
    }

    expect(queueManagers.size).toBe(1);
    expect(queueManagers.has('stash')).toBe(true);
    expect(config.watchProject).toBe('stash');
  });
});
