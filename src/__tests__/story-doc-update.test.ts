import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStoryDocUpdate, StoryDocUpdateResult, sanitizeSlug } from '../story-doc-update';
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

describe('sanitizeSlug', () => {
  it('英数字・ハイフン・アンダースコアはそのまま通す', () => {
    expect(sanitizeSlug('my-story_01')).toBe('my-story_01');
  });

  it('特殊文字を除去する', () => {
    expect(sanitizeSlug('; rm -rf /')).toBe('rm-rf/');
  });

  it('シェルインジェクション文字を除去する', () => {
    expect(sanitizeSlug('test$(whoami)')).toBe('testwhoami');
  });

  it('バッククォートを除去する', () => {
    expect(sanitizeSlug('test`id`')).toBe('testid');
  });

  it('空文字を含む slug はサニタイズ後に空になる', () => {
    expect(sanitizeSlug('; ; ;')).toBe('');
  });

  it('ドットを許可する', () => {
    expect(sanitizeSlug('v1.2.3-update')).toBe('v1.2.3-update');
  });
});

describe('runStoryDocUpdate', () => {
  let notifier: FakeNotifier;
  let deps: RunnerDeps;
  const repoPath = '/repo/test-project';

  beforeEach(() => {
    notifier = new FakeNotifier();
  });

  describe('slug バリデーション', () => {
    it('サニタイズ後に空になる slug はエラーを投げる', async () => {
      deps = createFakeDeps({
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        runStoryDocUpdate(
          makeStory({ slug: '; ; ;' }),
          [makeTask('01-task')],
          repoPath,
          notifier,
          deps,
        ),
      ).rejects.toThrow('Invalid story slug');
    });

    it('特殊文字を含む slug がサニタイズされてブランチ名に使われる', async () => {
      const execCommand = vi.fn().mockReturnValue('');
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(
        makeStory({ slug: 'my-story$(evil)' }),
        [makeTask('01-task')],
        repoPath,
        notifier,
        deps,
      );

      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      // サニタイズされたブランチ名が使われる
      expect(calls.some((c: string) => c.includes('docs/story-my-storyevil'))).toBe(true);
      // 元の危険な文字列が含まれない
      expect(calls.every((c: string) => !c.includes('$(evil)'))).toBe(true);
    });
  });

  describe('README 更新が不要な場合', () => {
    it('Agent が何も変更しなければ skipped: true を返す', async () => {
      deps = createFakeDeps({
        // git status --porcelain で空文字を返す（変更なし）
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
        if (cmd === 'git status --porcelain') return ' M README.md\n';
        if (cmd === 'git diff --cached --name-only') return 'README.md\n';
        return '';
      });
      const execGh = vi.fn().mockReturnValue('https://github.com/test/repo/pull/42\n');
      deps = createFakeDeps({
        execCommand,
        execGh,
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
        if (cmd === 'git status --porcelain') return ' M README.md\n';
        if (cmd === 'git diff --cached --name-only') return 'README.md\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        execGh: vi.fn().mockReturnValue('https://github.com/test/repo/pull/1\n'),
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      expect(calls.some((c: string) => c.includes('git checkout -b docs/story-test-story'))).toBe(true);
    });

    it('commit メッセージにストーリー slug が含まれる', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return ' M README.md\n';
        if (cmd === 'git diff --cached --name-only') return 'README.md\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        execGh: vi.fn().mockReturnValue('https://github.com/test/repo/pull/1\n'),
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      const commitCall = calls.find((c: string) => c.includes('git commit'));
      expect(commitCall).toContain('test-story');
    });

    it('PR タイトル・本文にストーリー情報が含まれる（execGh 経由）', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return ' M README.md\n';
        if (cmd === 'git diff --cached --name-only') return 'README.md\n';
        return '';
      });
      const execGh = vi.fn().mockReturnValue('https://github.com/test/repo/pull/1\n');
      deps = createFakeDeps({
        execCommand,
        execGh,
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

      // execGh が配列引数で呼ばれる
      expect(execGh).toHaveBeenCalledTimes(1);
      const args = execGh.mock.calls[0][0] as string[];
      expect(args).toContain('pr');
      expect(args).toContain('create');
      expect(args).toContain('--title');
      // タイトルにストーリー slug が含まれる
      const titleIndex = args.indexOf('--title');
      expect(args[titleIndex + 1]).toContain('test-story');
    });

    it('git add README.md で README のみステージングされる', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return ' M README.md\n';
        if (cmd === 'git diff --cached --name-only') return 'README.md\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        execGh: vi.fn().mockReturnValue('https://github.com/test/repo/pull/1\n'),
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      // git add -A ではなく git add README.md が呼ばれる
      expect(calls).toContain('git add README.md');
      expect(calls.every((c: string) => c !== 'git add -A')).toBe(true);
    });
  });

  describe('Agent が README 以外のファイルを変更した場合', () => {
    it('README 以外の変更はリセットされ、README のみコミットされる', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return ' M README.md\n?? src/temp.ts\n M .env\n';
        if (cmd === 'git diff --cached --name-only') return 'README.md\n';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        execGh: vi.fn().mockReturnValue('https://github.com/test/repo/pull/1\n'),
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      const result = await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      expect(result.skipped).toBe(false);
      const calls = execCommand.mock.calls.map((c: string[]) => c[0]);
      // README 以外のファイルがリセットされる
      expect(calls.some((c: string) => c.includes('git checkout -- src/temp.ts') || c.includes('git clean -f -- src/temp.ts'))).toBe(true);
      expect(calls.some((c: string) => c.includes('git checkout -- .env') || c.includes('git clean -f -- .env'))).toBe(true);
    });

    it('README 以外のファイルのみ変更された場合は skipped を返す', async () => {
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'git status --porcelain') return '?? src/temp.ts\n';
        if (cmd === 'git diff --cached --name-only') return '';
        return '';
      });
      deps = createFakeDeps({
        execCommand,
        runAgent: vi.fn().mockResolvedValue(undefined),
        syncMainBranch: vi.fn().mockResolvedValue(undefined),
      });

      const result = await runStoryDocUpdate(makeStory(), [makeTask('01-task')], repoPath, notifier, deps);

      expect(result.skipped).toBe(true);
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
