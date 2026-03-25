import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../../__tests__/helpers/fake-vault';
import { updateFileStatus, recordTaskCompletion, createTaskFile, TaskDraft } from '../writer';

// vaultTasksPath をモックして createTaskFile のテストで一時ディレクトリを使えるようにする
vi.mock('../../config', () => ({
  vaultTasksPath: (project: string, storySlug: string) =>
    (globalThis as Record<string, unknown>).__testVaultTasksPath as string,
}));

describe('vault/writer', () => {
  let vault: FakeVaultResult;

  afterEach(() => {
    vault?.cleanup();
  });

  // ─── updateFileStatus ───────────────────────────────────

  describe('updateFileStatus', () => {
    it('ステータスを変更できる', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1', status: 'Todo' },
        tasks: [{ slug: 'task-01', status: 'Todo' }],
      });

      const taskPath = vault.taskFilePaths[0];
      updateFileStatus(taskPath, 'Doing');

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.status).toBe('Doing');
    });

    it('ステータスを複数回変更できる', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Todo' }],
      });

      const taskPath = vault.taskFilePaths[0];
      updateFileStatus(taskPath, 'Doing');
      updateFileStatus(taskPath, 'Done');

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.status).toBe('Done');
    });

    it('ストーリーファイルのステータスも変更できる', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1', status: 'Backlog' },
      });

      updateFileStatus(vault.storyFilePath, 'Doing');

      const updated = matter(fs.readFileSync(vault.storyFilePath, 'utf-8'));
      expect(updated.data.status).toBe('Doing');
    });

    it('他のフロントマターフィールドを壊さない', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Todo', priority: 'high', effort: 'low' }],
      });

      const taskPath = vault.taskFilePaths[0];
      updateFileStatus(taskPath, 'Doing');

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.priority).toBe('high');
      expect(updated.data.effort).toBe('low');
      expect(updated.data.story).toBe('story-1');
    });

    it('存在しないファイルでエラーを投げる', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
      });

      expect(() => updateFileStatus('/tmp/nonexistent-file.md', 'Doing')).toThrow();
    });
  });

  // ─── recordTaskCompletion ───────────────────────────────

  describe('recordTaskCompletion', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('通常フローで prUrl を記録する', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Doing' }],
      });

      const taskPath = vault.taskFilePaths[0];
      recordTaskCompletion(taskPath, {
        mode: 'normal',
        prUrl: 'https://github.com/org/repo/pull/42',
      });

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.status).toBe('Done');
      expect(updated.data.pr).toBe('https://github.com/org/repo/pull/42');
      expect(updated.data.mode).toBe('normal');
    });

    it('finished_at が ISO 日付形式（YYYY-MM-DD）で記録される', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Doing' }],
      });

      const taskPath = vault.taskFilePaths[0];
      recordTaskCompletion(taskPath, { prUrl: 'https://github.com/org/repo/pull/1' });

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.finished_at).toBe('2026-03-25');
      expect(updated.data.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('local-only モードで localCommitSha を記録する', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Doing' }],
      });

      const taskPath = vault.taskFilePaths[0];
      recordTaskCompletion(taskPath, {
        mode: 'local-only',
        prUrl: null,
        localCommitSha: 'abc123def456',
      });

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.status).toBe('Done');
      expect(updated.data.mode).toBe('local-only');
      expect(updated.data.pr).toBeNull();
      expect(updated.data.commit_sha).toBe('abc123def456');
    });

    it('mode が未指定の場合は mode フィールドが書き込まれない（後方互換性）', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Doing' }],
      });

      const taskPath = vault.taskFilePaths[0];
      recordTaskCompletion(taskPath, {
        prUrl: 'https://github.com/org/repo/pull/99',
      });

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.status).toBe('Done');
      expect(updated.data.pr).toBe('https://github.com/org/repo/pull/99');
      expect(updated.data).not.toHaveProperty('mode');
    });

    it('localCommitSha が null/undefined の場合は commit_sha が書き込まれない', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Doing' }],
      });

      const taskPath = vault.taskFilePaths[0];
      recordTaskCompletion(taskPath, {
        mode: 'normal',
        prUrl: 'https://github.com/org/repo/pull/10',
        localCommitSha: null,
      });

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data).not.toHaveProperty('commit_sha');
    });

    it('既存フロントマターフィールドを保持する', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [{ slug: 'task-01', status: 'Doing', priority: 'high', effort: 'low' }],
      });

      const taskPath = vault.taskFilePaths[0];
      recordTaskCompletion(taskPath, {
        prUrl: 'https://github.com/org/repo/pull/5',
      });

      const updated = matter(fs.readFileSync(taskPath, 'utf-8'));
      expect(updated.data.priority).toBe('high');
      expect(updated.data.effort).toBe('low');
      expect(updated.data.story).toBe('story-1');
      expect(updated.data.project).toBe('test-proj');
    });

    it('gray-matter キャッシュ問題: 同一ファイルに対する連続操作で data が汚染されない', () => {
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
        tasks: [
          { slug: 'task-01', status: 'Doing' },
          { slug: 'task-02', status: 'Doing' },
        ],
      });

      // task-01 を local-only で完了
      recordTaskCompletion(vault.taskFilePaths[0], {
        mode: 'local-only',
        prUrl: null,
        localCommitSha: 'sha-111',
      });

      // task-02 を normal で完了（task-01 の mode/commit_sha が混ざらないこと）
      recordTaskCompletion(vault.taskFilePaths[1], {
        mode: 'normal',
        prUrl: 'https://github.com/org/repo/pull/20',
      });

      const task2 = matter(fs.readFileSync(vault.taskFilePaths[1], 'utf-8'));
      expect(task2.data.mode).toBe('normal');
      expect(task2.data.pr).toBe('https://github.com/org/repo/pull/20');
      expect(task2.data).not.toHaveProperty('commit_sha');
    });
  });

  // ─── createTaskFile ─────────────────────────────────────

  describe('createTaskFile', () => {
    let tmpDir: string;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));

      // createFakeVault で一時 Vault を用意し、そのパスを vaultTasksPath モックに渡す
      vault = createFakeVault({
        project: 'test-proj',
        story: { slug: 'story-1' },
      });
      tmpDir = vault.tasksDir;
      (globalThis as Record<string, unknown>).__testVaultTasksPath = tmpDir;
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (globalThis as Record<string, unknown>).__testVaultTasksPath;
    });

    const baseDraft: TaskDraft = {
      slug: 'new-task-01',
      title: 'テストタスク',
      priority: 'high',
      effort: 'medium',
      purpose: 'テスト目的',
      detail: 'テスト詳細',
      criteria: ['条件A', '条件B'],
    };

    it('タスクファイルを生成し、パスを返す', () => {
      const result = createTaskFile('test-proj', 'story-1', baseDraft);

      expect(result).toContain('new-task-01.md');
      expect(fs.existsSync(result)).toBe(true);
    });

    it('フロントマターに正しいフィールドが含まれる', () => {
      const filePath = createTaskFile('test-proj', 'story-1', baseDraft);
      const parsed = matter(fs.readFileSync(filePath, 'utf-8'));

      expect(parsed.data.status).toBe('Todo');
      expect(parsed.data.priority).toBe('high');
      expect(parsed.data.effort).toBe('medium');
      expect(parsed.data.story).toBe('story-1');
      expect(parsed.data.project).toBe('test-proj');
      expect(parsed.data.created).toBe('2026-03-25');
      expect(parsed.data.due).toBeNull();
      expect(parsed.data.finished_at).toBeNull();
      expect(parsed.data.pr).toBeNull();
    });

    it('created が ISO 日付形式（YYYY-MM-DD）である', () => {
      const filePath = createTaskFile('test-proj', 'story-1', baseDraft);
      const parsed = matter(fs.readFileSync(filePath, 'utf-8'));

      expect(parsed.data.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('マークダウン本文にタイトル・目的・詳細・完了条件が含まれる', () => {
      const filePath = createTaskFile('test-proj', 'story-1', baseDraft);
      const parsed = matter(fs.readFileSync(filePath, 'utf-8'));

      expect(parsed.content).toContain('# テストタスク');
      expect(parsed.content).toContain('## 目的');
      expect(parsed.content).toContain('テスト目的');
      expect(parsed.content).toContain('## 詳細');
      expect(parsed.content).toContain('テスト詳細');
      expect(parsed.content).toContain('- [ ] 条件A');
      expect(parsed.content).toContain('- [ ] 条件B');
    });

    it('ディレクトリが存在しない場合に再帰的に作成する', () => {
      // 存在しないサブディレクトリを指すようモックを変更
      const nestedDir = `${tmpDir}/deep/nested/dir`;
      (globalThis as Record<string, unknown>).__testVaultTasksPath = nestedDir;

      const filePath = createTaskFile('test-proj', 'story-1', baseDraft);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(filePath).toContain('deep/nested/dir');
    });

    it('ファイルが既に存在する場合にエラーを投げる', () => {
      createTaskFile('test-proj', 'story-1', baseDraft);

      expect(() => createTaskFile('test-proj', 'story-1', baseDraft)).toThrow(
        /Task file already exists/,
      );
    });
  });
});
