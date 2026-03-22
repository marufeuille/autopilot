import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from './fake-vault';

describe('createFakeVault', () => {
  let vault: FakeVaultResult | undefined;

  afterEach(() => {
    vault?.cleanup();
    vault = undefined;
  });

  it('一時ディレクトリに Vault 構造を作成する', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: { slug: 'my-story' },
    });

    expect(fs.existsSync(vault.vaultPath)).toBe(true);
    expect(fs.existsSync(vault.projectPath)).toBe(true);
    expect(fs.existsSync(vault.storyFilePath)).toBe(true);
    expect(fs.existsSync(vault.tasksDir)).toBe(true);
  });

  it('ストーリーファイルに正しい frontmatter が書き込まれる', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: { slug: 'my-story', status: 'Todo', title: 'テストストーリー' },
    });

    const raw = fs.readFileSync(vault.storyFilePath, 'utf-8');
    const { data, content } = matter(raw);

    expect(data.status).toBe('Todo');
    expect(data.project).toBe('test-project');
    expect(content).toContain('テストストーリー');
  });

  it('デフォルトのストーリーステータスは Doing', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: { slug: 'my-story' },
    });

    const raw = fs.readFileSync(vault.storyFilePath, 'utf-8');
    const { data } = matter(raw);

    expect(data.status).toBe('Doing');
  });

  it('タスクファイルを生成できる', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: { slug: 'my-story' },
      tasks: [
        { slug: 'my-story-01-setup', status: 'Todo', title: 'セットアップ' },
        { slug: 'my-story-02-impl', status: 'Doing', title: '実装' },
      ],
    });

    expect(vault.taskFilePaths).toHaveLength(2);
    expect(vault.taskFilePaths.every((p) => fs.existsSync(p))).toBe(true);

    // 1 つ目のタスクを検証
    const raw = fs.readFileSync(vault.taskFilePaths[0], 'utf-8');
    const { data, content } = matter(raw);

    expect(data.status).toBe('Todo');
    expect(data.story).toBe('my-story');
    expect(data.project).toBe('test-project');
    expect(content).toContain('セットアップ');
  });

  it('タスクの frontmatter をカスタマイズできる', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: { slug: 'my-story' },
      tasks: [
        {
          slug: 'my-story-01-task',
          priority: 'high',
          effort: 'low',
          frontmatter: { pr: 'https://github.com/test/repo/pull/42' },
        },
      ],
    });

    const raw = fs.readFileSync(vault.taskFilePaths[0], 'utf-8');
    const { data } = matter(raw);

    expect(data.priority).toBe('high');
    expect(data.effort).toBe('low');
    expect(data.pr).toBe('https://github.com/test/repo/pull/42');
  });

  it('ストーリーの frontmatter をカスタマイズできる', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: {
        slug: 'my-story',
        frontmatter: { priority: 'high', effort: 'high' },
      },
    });

    const raw = fs.readFileSync(vault.storyFilePath, 'utf-8');
    const { data } = matter(raw);

    expect(data.priority).toBe('high');
    expect(data.effort).toBe('high');
  });

  it('cleanup で一時ディレクトリを削除できる', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: { slug: 'my-story' },
      tasks: [{ slug: 'my-story-01-task' }],
    });

    const vaultPath = vault.vaultPath;
    expect(fs.existsSync(vaultPath)).toBe(true);

    vault.cleanup();
    expect(fs.existsSync(vaultPath)).toBe(false);
    vault = undefined; // afterEach で二重 cleanup しないように
  });

  it('ファイルパスが正しい構造になっている', () => {
    vault = createFakeVault({
      project: 'my-proj',
      story: { slug: 'feature-story' },
      tasks: [{ slug: 'feature-story-01-task' }],
    });

    // ストーリーパスの構造を検証
    expect(vault.storyFilePath).toBe(
      path.join(vault.vaultPath, 'Projects', 'my-proj', 'stories', 'feature-story.md'),
    );

    // タスクディレクトリの構造を検証
    expect(vault.tasksDir).toBe(
      path.join(vault.vaultPath, 'Projects', 'my-proj', 'tasks', 'feature-story'),
    );

    // タスクファイルパスの構造を検証
    expect(vault.taskFilePaths[0]).toBe(
      path.join(vault.tasksDir, 'feature-story-01-task.md'),
    );
  });

  it('タスクなしでも正常に動作する', () => {
    vault = createFakeVault({
      project: 'test-project',
      story: { slug: 'empty-story' },
    });

    expect(vault.taskFilePaths).toHaveLength(0);
    expect(fs.existsSync(vault.tasksDir)).toBe(true);
  });
});
