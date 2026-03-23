import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';
import { recordTaskCompletion } from '../vault/writer';

/**
 * テスト用タスクファイルを一時ディレクトリに作成し、テスト終了後にクリーンアップする。
 */
function createTestFile(): { filePath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-writer-test-'));
  const filePath = path.join(tmpDir, 'task.md');
  const frontmatter = {
    status: 'Doing',
    priority: 'medium',
    effort: 'medium',
    story: 'test-story',
    due: null,
    project: 'test-project',
    created: '2026-01-01',
    finished_at: null,
    pr: null,
  };
  fs.writeFileSync(filePath, matter.stringify('\n# Test Task\n\nテスト\n', frontmatter));
  return { filePath, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

describe('recordTaskCompletion', () => {
  it('ローカルオンリー時に mode: local-only が記録される', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { mode: 'local-only', prUrl: null, localCommitSha: 'abc123def' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.mode).toBe('local-only');
    } finally { cleanup(); }
  });

  it('ローカルオンリー時に prUrl が null (pr: null) で記録される', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { mode: 'local-only', prUrl: null, localCommitSha: 'abc123def' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.pr).toBeNull();
    } finally { cleanup(); }
  });

  it('ローカルオンリー時に commit_sha にコミットSHAが記録される', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { mode: 'local-only', prUrl: null, localCommitSha: 'abc123def' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.commit_sha).toBe('abc123def');
    } finally { cleanup(); }
  });

  it('ローカルオンリー時に status が Done に更新される', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { mode: 'local-only', prUrl: null, localCommitSha: 'abc123def' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.status).toBe('Done');
    } finally { cleanup(); }
  });

  it('ローカルオンリー時に finished_at が設定される', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { mode: 'local-only', prUrl: null, localCommitSha: 'abc123def' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally { cleanup(); }
  });

  it('リモートありの場合は pr に URL が記録される', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { prUrl: 'https://github.com/test/repo/pull/1' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.pr).toBe('https://github.com/test/repo/pull/1');
    } finally { cleanup(); }
  });

  it('リモートありの場合は mode フィールドが設定されない', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { prUrl: 'https://github.com/test/repo/pull/1' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.mode).toBeUndefined();
    } finally { cleanup(); }
  });

  it('リモートありの場合は commit_sha フィールドが設定されない', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { prUrl: 'https://github.com/test/repo/pull/1' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.commit_sha).toBeUndefined();
    } finally { cleanup(); }
  });

  it('既存のフロントマターフィールドが保持される（後方互換性）', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { mode: 'local-only', prUrl: null, localCommitSha: 'abc123' });
      const { data } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(data.priority).toBe('medium');
      expect(data.effort).toBe('medium');
      expect(data.story).toBe('test-story');
      expect(data.project).toBe('test-project');
      expect(data.created).toBe('2026-01-01');
    } finally { cleanup(); }
  });

  it('コンテンツ（本文）が保持される', () => {
    const { filePath, cleanup } = createTestFile();
    try {
      recordTaskCompletion(filePath, { mode: 'local-only', prUrl: null, localCommitSha: 'abc123' });
      const { content } = matter(fs.readFileSync(filePath, 'utf-8'));
      expect(content).toContain('# Test Task');
      expect(content).toContain('テスト');
    } finally { cleanup(); }
  });
});
