import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps } from '../helpers/fake-deps';
import { runStory } from '../../runner';
import { readStoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus, recordTaskCompletion, TaskCompletionRecord } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

// detectNoRemote をモック化
vi.mock('../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git')>();
  return { ...actual, detectNoRemote: vi.fn().mockReturnValue(false) };
});

// runMergePollingLoop をモック化
vi.mock('../../merge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../merge')>();
  return {
    ...actual,
    runMergePollingLoop: vi.fn().mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 }),
  };
});

// ---------------------------------------------------------------------------
// Helper: fake vault のタスクディレクトリから TaskFile[] を読み取る
// ---------------------------------------------------------------------------
async function readTasksFromVault(
  tasksDir: string,
  project: string,
  storySlug: string,
): Promise<TaskFile[]> {
  const files = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(tasksDir, f))
    : [];
  const tasks: TaskFile[] = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const data = { ...parsed.data };
    tasks.push({
      filePath,
      project,
      storySlug,
      slug: path.basename(filePath, '.md'),
      status: (data.status as TaskStatus) ?? 'Todo',
      frontmatter: data,
      content: parsed.content,
    });
  }
  return tasks.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Helper: 結合テスト用の deps を生成する
// ---------------------------------------------------------------------------
function createIntegrationDeps(
  vault: FakeVaultResult,
  overrides?: Partial<RunnerDeps>,
): RunnerDeps {
  const { tasksDir } = vault;

  const integrationOverrides: Partial<RunnerDeps> = {
    getStoryTasks: vi.fn().mockImplementation(
      async (proj: string, slug: string) => readTasksFromVault(tasksDir, proj, slug),
    ),
    updateFileStatus: vi.fn().mockImplementation(
      (filePath: string, status: TaskStatus) => updateFileStatus(filePath, status),
    ),
    recordTaskCompletion: vi.fn().mockImplementation(
      (filePath: string, record: TaskCompletionRecord) => recordTaskCompletion(filePath, record),
    ),
    createTaskFile: vi.fn(),
    execCommand: vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr create') || cmd.includes('gh pr view')) {
        return 'https://github.com/test/repo/pull/1';
      }
      return '';
    }),
  };

  const merged = overrides
    ? { ...integrationOverrides, ...overrides }
    : integrationOverrides;

  return createFakeDeps(merged);
}

// ---------------------------------------------------------------------------
// Helper: テスト用 vault を作成し、テスト完了後にクリーンアップする
// ---------------------------------------------------------------------------
function withVault(
  fn: (vault: FakeVaultResult) => Promise<void>,
  options: Parameters<typeof createFakeVault>[0],
): () => Promise<void> {
  return async () => {
    matter.clearCache();
    const vault = createFakeVault(options);
    try {
      await fn(vault);
    } finally {
      vault.cleanup();
    }
  };
}

// ===========================================================================
// REPO_BASE_PATH 結合テスト
// ===========================================================================
describe('REPO_BASE_PATH 結合テスト', () => {
  const origEnv = {
    HOME: process.env.HOME,
    REPO_BASE_PATH: process.env.REPO_BASE_PATH,
  };

  afterEach(() => {
    // 環境変数を元に戻す
    if (origEnv.HOME !== undefined) {
      process.env.HOME = origEnv.HOME;
    } else {
      delete process.env.HOME;
    }
    if (origEnv.REPO_BASE_PATH !== undefined) {
      process.env.REPO_BASE_PATH = origEnv.REPO_BASE_PATH;
    } else {
      delete process.env.REPO_BASE_PATH;
    }
  });

  // -------------------------------------------------------------------------
  // REPO_BASE_PATH を設定した場合に正しいパスが使われる
  // -------------------------------------------------------------------------
  describe('REPO_BASE_PATH を設定した場合に正しいパスが使われる', () => {
    const PROJECT = 'repo-path-project';
    const STORY_SLUG = 'repo-path-story';

    it(
      'REPO_BASE_PATH が設定されている場合、repoPath が REPO_BASE_PATH/<project> になる',
      withVault(async (vault) => {
        const customBasePath = '/workspace/custom';
        process.env.REPO_BASE_PATH = customBasePath;
        const expectedRepoPath = `${customBasePath}/${PROJECT}`;

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // syncMainBranch に渡された repoPath が REPO_BASE_PATH/project になっている
        expect(deps.syncMainBranch).toHaveBeenCalledWith(expectedRepoPath);

        // createWorktree の第1引数（repoPath）が期待値
        expect(deps.createWorktree).toHaveBeenCalledWith(
          expectedRepoPath,
          expect.any(String),
          expect.any(String),
        );
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'REPO_BASE_PATH が HOME より優先される',
      withVault(async (vault) => {
        process.env.HOME = '/home/user';
        process.env.REPO_BASE_PATH = '/override/path';
        const expectedRepoPath = `/override/path/${PROJECT}`;
        const homeBasedPath = `/home/user/dev/${PROJECT}`;

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // syncMainBranch が REPO_BASE_PATH ベースのパスで呼ばれている
        expect(deps.syncMainBranch).toHaveBeenCalledWith(expectedRepoPath);

        // HOME ベースのパスでは呼ばれていない
        expect(deps.syncMainBranch).not.toHaveBeenCalledWith(homeBasedPath);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // HOME 未設定かつ REPO_BASE_PATH 未設定でエラーになる
  // -------------------------------------------------------------------------
  describe('HOME 未設定かつ REPO_BASE_PATH 未設定でエラーになる', () => {
    const PROJECT = 'error-project';
    const STORY_SLUG = 'error-story';

    it(
      'HOME も REPO_BASE_PATH も未設定の場合、runStory が明示的なエラーを投げる',
      withVault(async (vault) => {
        delete process.env.HOME;
        delete process.env.REPO_BASE_PATH;

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);

        await expect(runStory(story, notifier, deps)).rejects.toThrow(
          'Cannot resolve repo path: neither REPO_BASE_PATH nor HOME environment variable is set.',
        );
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'エラーメッセージに REPO_BASE_PATH の設定を促す内容が含まれる',
      withVault(async (vault) => {
        delete process.env.HOME;
        delete process.env.REPO_BASE_PATH;

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);

        await expect(runStory(story, notifier, deps)).rejects.toThrow(
          /Please set REPO_BASE_PATH/,
        );
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 環境変数のリークが起きないことの検証
  // -------------------------------------------------------------------------
  describe('環境変数のリークが起きない', () => {
    const PROJECT = 'leak-project';
    const STORY_SLUG = 'leak-story';

    it(
      'テスト 1: REPO_BASE_PATH を設定する',
      withVault(async (vault) => {
        process.env.REPO_BASE_PATH = '/test-specific-path';

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // このテスト内では /test-specific-path が使われている
        expect(deps.syncMainBranch).toHaveBeenCalledWith(`/test-specific-path/${PROJECT}`);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'テスト 2: 前のテストの REPO_BASE_PATH がリークしていない',
      () => {
        // afterEach で元に戻されているため、origEnv の値と一致するはず
        if (origEnv.REPO_BASE_PATH !== undefined) {
          expect(process.env.REPO_BASE_PATH).toBe(origEnv.REPO_BASE_PATH);
        } else {
          expect(process.env.REPO_BASE_PATH).toBeUndefined();
        }
      },
    );
  });
});
