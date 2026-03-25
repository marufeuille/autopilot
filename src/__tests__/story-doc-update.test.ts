import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStoryDocUpdate, StoryDocUpdateResult } from '../story-doc-update';
import { StoryFile, TaskFile } from '../vault/reader';
import { FakeNotifier } from './helpers/fake-notifier';
import { createFakeDeps } from './helpers/fake-deps';
import { RunnerDeps } from '../runner-deps';

function makeStory(overrides?: Partial<StoryFile>): StoryFile {
  return {
    filePath: '/vault/stories/test-story.md',
    project: 'test-project',
    slug: 'test-story',
    status: 'Doing',
    frontmatter: {},
    content: '## 概要\nテストストーリー',
    ...overrides,
  };
}

function makeTask(slug: string, overrides?: Partial<TaskFile>): TaskFile {
  return {
    filePath: `/vault/tasks/test-story/${slug}.md`,
    project: 'test-project',
    storySlug: 'test-story',
    slug,
    status: 'Done',
    frontmatter: {},
    content: `## ${slug}\nタスク内容`,
    ...overrides,
  };
}

describe('runStoryDocUpdate', () => {
  let notifier: FakeNotifier;
  let deps: RunnerDeps;
  const repoPath = '/repo/test-project';

  beforeEach(() => {
    notifier = new FakeNotifier();
  });

  describe('README 更新が不要な場合', () => {
    it('Agent が何も変更しなければ skipped: true を返す', async () => {
      deps = createFakeDeps({
        // git diff --name-only で空文字を返す（変更なし）
        execCommand: vi.fn().mockReturnValue(''),
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      const result = await runStoryDocUpdate(
        makeStory(),
        [makeTask('01-task-a'), makeTask('02-task-b')],
        repoPath,
        notifier,
        deps,
      );

      expect(result.skipped).toBe(true);
      expect(result.prUrl).toBeUndefined();
    });

    it('ブランチ作成後にスキップした場合、ブランチが削除される', async () => {
      const execCommand = vi.fn().mockReturnValue('');
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      // git checkout main と git branch -D が呼ばれる
      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      expect(calls).toContain('git checkout main');
      expect(calls.some((c: string) => c.includes('git branch -D docs/story-test-story'))).toBe(true);
    });
  });

  describe('README 更新が必要な場合', () => {
    it('PR を作成して prUrl を返す', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git diff --name-only') return 'README.md\n';
        if (cmd.includes('gh pr create')) return 'https://github.com/test/repo/pull/42\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      const result = await runStoryDocUpdate(
        makeStory(),
        [makeTask('01-task-a'), makeTask('02-task-b')],
        repoPath,
        notifier,
        deps,
      );

      expect(result.skipped).toBe(false);
      expect(result.prUrl).toBe('https://github.com/test/repo/pull/42');
    });

    it('docs/story-[slug] ブランチが作成される', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git diff --name-only') return 'README.md\n';
        if (cmd.includes('gh pr create')) return 'https://github.com/test/repo/pull/1\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      expect(calls.some((c: string) => c.includes('git checkout -b docs/story-test-story'))).toBe(true);
    });

    it('commit メッセージにストーリー slug が含まれる', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git diff --name-only') return 'README.md\n';
        if (cmd.includes('gh pr create')) return 'https://github.com/test/repo/pull/1\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      const commitCall = calls.find((c: string) => c.includes('git commit'));
      expect(commitCall).toContain('test-story');
    });

    it('PR タイトル・本文にストーリー情報が含まれる', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git diff --name-only') return 'README.md\n';
        if (cmd.includes('gh pr create')) return 'https://github.com/test/repo/pull/1\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(
        makeStory(),
        [makeTask('01-task-a')],
        repoPath,
        notifier,
        deps,
      );

      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      const prCreateCall = calls.find((c: string) => c.includes('gh pr create'));
      expect(prCreateCall).toContain('test-story');
      expect(prCreateCall).toContain('--title');
    });
  });

  describe('エラーハンドリング', () => {
    it('Agent 実行でエラーが発生した場合、main に戻して re-throw する', async () => {
      const execCommand = vi.fn().mockReturnValue('');
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockRejectedValue(new Error('Agent failed')),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps),
      ).rejects.toThrow('Agent failed');

      // main に戻す試行
      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      const checkoutMainCalls = calls.filter((c: string) => c === 'git checkout main');
      expect(checkoutMainCalls.length).toBeGreaterThan(0);
    });

    it('syncMainBranch でエラーが発生した場合も re-throw する', async () => {
      deps = createFakeDeps({
        syncMainBranch: vi.fn().mockRejectedValue(new Error('Sync failed')),
      });

      await expect(
        runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps),
      ).rejects.toThrow('Sync failed');
    });
  });

  describe('プロンプト生成', () => {
    it('全タスクの内容がプロンプトに含まれる', async () => {
      const runAgent = vi.fn().mockResolvedValue(undefined);
      deps = createFakeDeps({
        execCommand: vi.fn().mockReturnValue(''),
        runAgent,
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(
        makeStory(),
        [makeTask('01-task-a'), makeTask('02-task-b')],
        repoPath,
        notifier,
        deps,
      );

      const prompt = runAgent.mock.calls[0][0] as string;
      expect(prompt).toContain('01-task-a');
      expect(prompt).toContain('02-task-b');
      expect(prompt).toContain('test-story');
    });
  });
});
