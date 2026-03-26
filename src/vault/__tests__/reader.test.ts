import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'path';
import { createFakeVault, FakeVaultResult } from '../../__tests__/helpers/fake-vault';
import { readStoryFile, getStoryTasks, getProjectReadmePath } from '../reader';

// getStoryTasks は内部で vaultTasksPath(project, storySlug) を使うため、
// config の vaultPath をフェイク Vault のパスに差し替える
vi.mock('../../config', () => ({
  vaultProjectPath: (project: string) => {
    const vaultPath = (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__ as string;
    return path.join(vaultPath, 'Projects', project);
  },
  vaultTasksPath: (project: string, storySlug: string) => {
    const vaultPath = (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__ as string;
    return path.join(vaultPath, 'Projects', project, 'tasks', storySlug);
  },
}));

describe('vault/reader', () => {
  let vault: FakeVaultResult | undefined;

  afterEach(() => {
    vault?.cleanup();
    vault = undefined;
    delete (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__;
  });

  // ─── readStoryFile ───────────────────────────────────

  describe('readStoryFile', () => {
    it('フロントマターとコンテンツを正しくパースする', () => {
      vault = createFakeVault({
        project: 'test-project',
        story: {
          slug: 'my-story',
          status: 'Doing',
          title: 'テストストーリー',
          frontmatter: { priority: 'high' },
        },
      });

      const story = readStoryFile(vault.storyFilePath);

      expect(story.filePath).toBe(vault.storyFilePath);
      expect(story.slug).toBe('my-story');
      expect(story.status).toBe('Doing');
      expect(story.project).toBe('test-project');
      expect(story.frontmatter.status).toBe('Doing');
      expect(story.frontmatter.priority).toBe('high');
      expect(story.content).toContain('テストストーリー');
    });

    it('status が未設定の場合は Todo を返す', () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'no-status' },
      });

      // frontmatter から status を削除して再書き込み
      const fs = require('fs');
      const raw = fs.readFileSync(vault.storyFilePath, 'utf-8');
      // フロントマターから status 行を除去
      const rewritten = raw.replace(/^status:.*\n/m, '');
      fs.writeFileSync(vault.storyFilePath, rewritten);

      const story = readStoryFile(vault.storyFilePath);
      expect(story.status).toBe('Todo');
    });

    it('project を filePath の Projects/ セグメントから抽出する', () => {
      vault = createFakeVault({
        project: 'another-proj',
        story: { slug: 'extract-project' },
      });

      const story = readStoryFile(vault.storyFilePath);
      expect(story.project).toBe('another-proj');
    });

    it('パスに Projects/ が含まれない場合は空文字を返す', () => {
      // 一時ファイルを Projects/ を含まないパスに直接作成
      const fs = require('fs');
      const os = require('os');
      const tmpFile = path.join(os.tmpdir(), 'no-projects-dir-story.md');
      fs.writeFileSync(tmpFile, '---\nstatus: Doing\n---\n\n# Test\n');

      try {
        const story = readStoryFile(tmpFile);
        expect(story.project).toBe('');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  // ─── getStoryTasks ──────────────────────────────────

  describe('getStoryTasks', () => {
    it('複数タスクをスラッグ順にソートして返す', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'sorted-story' },
        tasks: [
          { slug: '03-third', status: 'Todo' },
          { slug: '01-first', status: 'Done' },
          { slug: '02-second', status: 'Doing' },
        ],
      });
      (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__ = vault.vaultPath;

      const tasks = await getStoryTasks('test-project', 'sorted-story');

      expect(tasks).toHaveLength(3);
      expect(tasks[0].slug).toBe('01-first');
      expect(tasks[1].slug).toBe('02-second');
      expect(tasks[2].slug).toBe('03-third');
    });

    it('各タスクのフロントマターを正しくパースする', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'parse-story' },
        tasks: [
          {
            slug: '01-task',
            status: 'Todo',
            priority: 'high',
            effort: 'low',
            title: 'テストタスク',
          },
        ],
      });
      (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__ = vault.vaultPath;

      const tasks = await getStoryTasks('test-project', 'parse-story');

      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.status).toBe('Todo');
      expect(task.storySlug).toBe('parse-story');
      expect(task.project).toBe('test-project');
      expect(task.frontmatter.priority).toBe('high');
      expect(task.frontmatter.effort).toBe('low');
      expect(task.content).toContain('テストタスク');
    });

    it('タスクの status が未設定の場合はデフォルトで Todo を返す', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'no-status-story' },
        tasks: [{ slug: '01-no-status', status: 'Todo' }],
      });
      (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__ = vault.vaultPath;

      // タスクファイルから status 行を手動で削除
      const fs = require('fs');
      const raw = fs.readFileSync(vault.taskFilePaths[0], 'utf-8');
      const rewritten = raw.replace(/^status:.*\n/m, '');
      fs.writeFileSync(vault.taskFilePaths[0], rewritten);

      const tasks = await getStoryTasks('test-project', 'no-status-story');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('Todo');
    });

    it('タスクが0件の場合は空配列を返す', async () => {
      vault = createFakeVault({
        project: 'test-project',
        story: { slug: 'empty-story' },
        tasks: [],
      });
      (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__ = vault.vaultPath;

      const tasks = await getStoryTasks('test-project', 'empty-story');

      expect(tasks).toHaveLength(0);
      expect(tasks).toEqual([]);
    });
  });

  // ─── getProjectReadmePath ───────────────────────────

  describe('getProjectReadmePath', () => {
    it('正しいパスを組み立てる', () => {
      vault = createFakeVault({
        project: 'my-project',
        story: { slug: 'dummy' },
      });
      (globalThis as Record<string, unknown>).__TEST_VAULT_PATH__ = vault.vaultPath;

      const readmePath = getProjectReadmePath('my-project');

      expect(readmePath).toBe(
        path.join(vault.vaultPath, 'Projects', 'my-project', 'README.md'),
      );
    });
  });
});
