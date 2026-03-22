import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';

const mockVaultStoriesPath = vi.fn((project: string) => '');

vi.mock('../../config', () => ({
  config: {
    watchProject: 'test-project',
    vaultPath: '/vault',
    slack: { channelId: 'C_TEST' },
  },
  vaultStoriesPath: (...args: any[]) => mockVaultStoriesPath(...args),
}));

import {
  parseStoryDraft,
  generateSlug,
  buildStoryFileContent,
  createStoryFile,
} from '../story-writer';

describe('parseStoryDraft', () => {
  it('ドラフトテキストから各セクションを抽出する', () => {
    const draft = `### タイトル
ユーザー管理画面の実装

### 価値・ゴール
ユーザーが自分のプロフィールを管理できるようになる

### 受け入れ条件
- [ ] プロフィール編集ができる
- [ ] アバター画像をアップロードできる

### タスク案
1. プロフィールAPIの実装
2. UIコンポーネントの実装`;

    const parsed = parseStoryDraft(draft);

    expect(parsed.title).toBe('ユーザー管理画面の実装');
    expect(parsed.value).toContain('プロフィールを管理');
    expect(parsed.acceptance).toContain('プロフィール編集ができる');
    expect(parsed.acceptance).toContain('アバター画像をアップロードできる');
    expect(parsed.tasks).toContain('プロフィールAPIの実装');
    expect(parsed.tasks).toContain('UIコンポーネントの実装');
  });

  it('セクションが欠落している場合は空文字列を返す', () => {
    const draft = `### タイトル
テストタイトル`;

    const parsed = parseStoryDraft(draft);

    expect(parsed.title).toBe('テストタイトル');
    expect(parsed.value).toBe('');
    expect(parsed.acceptance).toBe('');
    expect(parsed.tasks).toBe('');
  });

  it('空のドラフトをパースできる', () => {
    const parsed = parseStoryDraft('');

    expect(parsed.title).toBe('');
    expect(parsed.value).toBe('');
    expect(parsed.acceptance).toBe('');
    expect(parsed.tasks).toBe('');
  });
});

describe('generateSlug', () => {
  it('英語タイトルをケバブケースに変換する', () => {
    expect(generateSlug('User Profile Management')).toBe('user-profile-management');
  });

  it('特殊文字を除去する', () => {
    expect(generateSlug('Add API v2 (beta)')).toBe('add-api-v2-beta');
  });

  it('連続するハイフンをまとめる', () => {
    expect(generateSlug('foo  --  bar')).toBe('foo-bar');
  });

  it('長いスラッグを60文字に切り詰める', () => {
    const longTitle = 'a'.repeat(100);
    const slug = generateSlug(longTitle);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('日本語タイトルの場合はタイムスタンプベースのスラッグを生成する', () => {
    const fixedDate = new Date('2026-03-22T10:30:45Z');
    const slug = generateSlug('ユーザー管理画面の実装', fixedDate);
    expect(slug).toBe('story-20260322-103045');
  });

  it('アクセント付きラテン文字を含むタイトルを正しく処理する（NFD正規化）', () => {
    expect(generateSlug('Café Menu')).toBe('cafe-menu');
    expect(generateSlug('Résumé Builder')).toBe('resume-builder');
    expect(generateSlug('naïve approach')).toBe('naive-approach');
  });
});

describe('buildStoryFileContent', () => {
  it('フロントマターと本文を含むMarkdownを生成する', () => {
    const parsed = {
      title: 'テストストーリー',
      value: 'テスト価値',
      acceptance: '- [ ] 条件1\n- [ ] 条件2',
      tasks: '1. タスク1\n2. タスク2',
    };

    const content = buildStoryFileContent(parsed, 'test-story', 'my-project');
    const { data, content: body } = matter(content);

    expect(data.status).toBe('Todo');
    expect(data.priority).toBe('medium');
    expect(data.effort).toBe('medium');
    expect(data.slug).toBe('test-story');
    expect(data.project).toBe('my-project');
    expect(data.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(body).toContain('# テストストーリー');
    expect(body).toContain('## 価値・ゴール');
    expect(body).toContain('テスト価値');
    expect(body).toContain('## 受け入れ条件');
    expect(body).toContain('- [ ] 条件1');
    expect(body).toContain('## タスク');
    expect(body).toContain('1. タスク1');
    expect(body).toContain('## メモ');
  });
});

describe('createStoryFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'story-writer-test-'));
    const storiesDir = path.join(tmpDir, 'Projects', 'test-project', 'stories');
    fs.mkdirSync(storiesDir, { recursive: true });

    // mock vaultStoriesPath to return tmpDir-based path
    mockVaultStoriesPath.mockImplementation(
      (project: string) => path.join(tmpDir, 'Projects', project, 'stories'),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ストーリーファイルをVaultに作成する', () => {
    const parsed = {
      title: 'Test Story',
      value: 'Some value',
      acceptance: '- [ ] Done',
      tasks: '1. Task',
    };

    const filePath = createStoryFile('test-project', parsed, 'test-story');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain('test-story.md');

    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);

    expect(data.slug).toBe('test-story');
    expect(data.status).toBe('Todo');
    expect(content).toContain('# Test Story');
  });

  it('同じスラッグのファイルが既に存在する場合はエラーを投げる', () => {
    const parsed = {
      title: 'Test Story',
      value: 'Value',
      acceptance: '- [ ] Done',
      tasks: '1. Task',
    };

    createStoryFile('test-project', parsed, 'duplicate-test');

    expect(() => {
      createStoryFile('test-project', parsed, 'duplicate-test');
    }).toThrow('Story file already exists');
  });

  it('storiesディレクトリが存在しない場合は再帰的に作成する', () => {
    mockVaultStoriesPath.mockImplementation(
      (project: string) => path.join(tmpDir, 'new-path', 'Projects', project, 'stories'),
    );

    const parsed = {
      title: 'New Story',
      value: 'Value',
      acceptance: '- [ ] Done',
      tasks: '1. Task',
    };

    const filePath = createStoryFile('test-project', parsed, 'new-story');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('slugを省略するとタイトルから自動生成する', () => {
    const parsed = {
      title: 'Auto Generated Slug',
      value: 'Value',
      acceptance: '- [ ] Done',
      tasks: '1. Task',
    };

    const filePath = createStoryFile('test-project', parsed);

    expect(filePath).toContain('auto-generated-slug.md');
  });
});
