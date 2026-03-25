import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps } from '../helpers/fake-deps';
import { runStory } from '../../runner';
import { readStoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus, recordTaskCompletion, TaskDraft, TaskCompletionRecord } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';

// ---------------------------------------------------------------------------
// detectNoRemote のモック制御
//
// vi.mock はホイスティングされるため、vi.hoisted() でモック関数を先に定義する。
// テストごとに detectNoRemote の返り値を mockReturnValue で切り替える。
// ---------------------------------------------------------------------------
const { mockDetectNoRemote } = vi.hoisted(() => ({
  mockDetectNoRemote: vi.fn().mockReturnValue(false),
}));
vi.mock('../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git')>();
  return { ...actual, detectNoRemote: mockDetectNoRemote };
});

// runMergePollingLoop をモック（手動マージポーリングをスキップ）
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
// Helper: frontmatter を読み取る
// ---------------------------------------------------------------------------
function readFrontmatter(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { ...matter(raw).data };
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
    // gh pr create / gh pr view で PR URL を返す
    execCommand: vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr create') || cmd.includes('gh pr view')) {
        return 'https://github.com/test/repo/pull/1';
      }
      // git rev-parse HEAD (ローカルオンリーモードで使用)
      if (cmd.includes('git rev-parse HEAD')) {
        return 'abc1234567890def';
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
// リモートなし（ローカルオンリー）E2E テスト
// ===========================================================================
describe('ローカルオンリーモード E2E テスト（リモートなし）', () => {
  const PROJECT = 'local-only-project';
  const STORY_SLUG = 'local-only-story';

  // -------------------------------------------------------------------------
  // テスト 1: リモートなしリポジトリで全パイプラインが正常完了する
  // -------------------------------------------------------------------------
  describe('リモートなしリポジトリで全パイプラインが正常完了する', () => {
    it(
      'start-approval → sync-main(skip) → implementation → pr-lifecycle(local) → done の順で完了',
      withVault(async (vault) => {
        // detectNoRemote を true に設定（リモートなし）
        mockDetectNoRemote.mockReturnValue(true);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスクが Done になっている
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');

        // ストーリーが Done になっている
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // syncMainBranch は呼ばれない（no-remote でスキップ）
        expect(deps.syncMainBranch).not.toHaveBeenCalled();

        // execGh は呼ばれない（PR作成なし）
        expect(deps.execGh).not.toHaveBeenCalled();

        // runCIPollingLoop は呼ばれない（CI なし）
        expect(deps.runCIPollingLoop).not.toHaveBeenCalled();

        // runAgent は呼ばれる（implementation のみ、doc-update は localOnly でスキップ）
        expect(deps.runAgent).toHaveBeenCalledTimes(1);
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
  // テスト 2: Vault にローカルオンリーとして正しく記録される
  // -------------------------------------------------------------------------
  describe('Vault にローカルオンリーとして正しく記録される', () => {
    it(
      'frontmatter に mode: local-only, pr: null, commit_sha が記録される',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(true);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // recordTaskCompletion が正しい引数で呼ばれた
        expect(deps.recordTaskCompletion).toHaveBeenCalledTimes(1);
        expect(deps.recordTaskCompletion).toHaveBeenCalledWith(
          vault.taskFilePaths[0],
          expect.objectContaining({
            mode: 'local-only',
            prUrl: null,
            localCommitSha: expect.any(String),
          }),
        );

        // 実際のファイル frontmatter を検証
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
        expect(taskFm.mode).toBe('local-only');
        expect(taskFm.pr).toBeNull();
        expect(taskFm.commit_sha).toBeDefined();
        expect(taskFm.finished_at).toBeDefined();
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
  // テスト 3: 複数タスクがすべてローカルオンリーで完了する
  // -------------------------------------------------------------------------
  describe('複数タスクがすべてローカルオンリーで完了する', () => {
    it(
      '全タスクが Done かつ mode: local-only で記録される',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(true);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 全タスクが Done
        for (const taskPath of vault.taskFilePaths) {
          const fm = readFrontmatter(taskPath);
          expect(fm.status).toBe('Done');
          expect(fm.mode).toBe('local-only');
          expect(fm.pr).toBeNull();
        }

        // ストーリーが Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // recordTaskCompletion がタスク数分呼ばれた
        expect(deps.recordTaskCompletion).toHaveBeenCalledTimes(3);

        // runAgent がタスク数分呼ばれた（implementation のみ、doc-update は localOnly でスキップ）
        expect(deps.runAgent).toHaveBeenCalledTimes(3);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-a`, status: 'Todo' },
          { slug: `${STORY_SLUG}-02-b`, status: 'Todo' },
          { slug: `${STORY_SLUG}-03-c`, status: 'Todo' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // テスト 4: ローカルオンリー通知が正しく送信される
  // -------------------------------------------------------------------------
  describe('ローカルオンリー通知が正しく送信される', () => {
    it(
      'ローカルオンリーモード通知とタスク完了通知が送信される',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(true);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ローカルオンリーモード通知
        const localOnlyNotification = notifier.notifications.find((n) =>
          n.message.includes('ローカルオンリーモード'),
        );
        expect(localOnlyNotification).toBeDefined();

        // タスク完了（ローカルオンリー）通知
        const completionNotification = notifier.notifications.find((n) =>
          n.message.includes('タスク完了（ローカルオンリー）'),
        );
        expect(completionNotification).toBeDefined();

        // ストーリー完了通知
        const storyCompletionNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(storyCompletionNotification).toBeDefined();
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
  // テスト 5: ローカルオンリーモードの承認フロー
  // -------------------------------------------------------------------------
  describe('ローカルオンリーモードの承認フロー', () => {
    it(
      'タスク開始承認のみが要求され、マージ承認は要求されない',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(true);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const approvals = notifier.approvalRequests;

        // タスク開始承認のみ（マージ承認なし）
        expect(approvals.length).toBe(1);
        expect(approvals[0].message).toContain('タスク開始確認');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });
});

// ===========================================================================
// リモートあり（通常フロー）E2E リグレッションテスト
// ===========================================================================
describe('リモートありフロー E2E リグレッションテスト', () => {
  const PROJECT = 'remote-project';
  const STORY_SLUG = 'remote-story';

  // -------------------------------------------------------------------------
  // テスト 1: 通常フローが変わらず動作する
  // -------------------------------------------------------------------------
  describe('通常フローが変わらず動作する', () => {
    it(
      'start-approval → sync-main → implementation → pr-lifecycle → done の全ステップが実行される',
      withVault(async (vault) => {
        // detectNoRemote を false に設定（リモートあり）
        mockDetectNoRemote.mockReturnValue(false);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスクが Done
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');

        // ストーリーが Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // syncMainBranch が呼ばれた（通常フロー + story-doc-update）
        expect(deps.syncMainBranch).toHaveBeenCalledTimes(2);

        // runAgent が呼ばれた（implementation + doc-update + story-doc-update）
        expect(deps.runAgent).toHaveBeenCalledTimes(3);

        // runCIPollingLoop が呼ばれた（CI ポーリング）
        expect(deps.runCIPollingLoop).toHaveBeenCalledTimes(1);
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
  // テスト 2: 通常フローの Vault 記録が正しい
  // -------------------------------------------------------------------------
  describe('通常フローの Vault 記録が正しい', () => {
    it(
      'frontmatter に pr URL が記録され mode フィールドがない',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(false);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // recordTaskCompletion が prUrl 付きで呼ばれた
        expect(deps.recordTaskCompletion).toHaveBeenCalledTimes(1);
        expect(deps.recordTaskCompletion).toHaveBeenCalledWith(
          vault.taskFilePaths[0],
          expect.objectContaining({
            prUrl: expect.any(String),
          }),
        );

        // prUrl が空でないこと
        const callArgs = (deps.recordTaskCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
        const record = callArgs[1] as TaskCompletionRecord;
        expect(record.prUrl).toBeTruthy();

        // 実際のファイル frontmatter を検証
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
        expect(taskFm.pr).toBeTruthy();
        expect(taskFm.finished_at).toBeDefined();
        // mode は設定されない（通常フロー）
        expect(taskFm.mode).toBeUndefined();
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
  // テスト 3: 通常フローの承認フロー（マージ承認含む）
  // -------------------------------------------------------------------------
  describe('通常フローの承認フロー', () => {
    it(
      'タスク開始承認のみが要求される（マージは手動）',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(false);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const approvals = notifier.approvalRequests;

        // タスク開始承認のみ（マージ承認は不要、手動マージ運用）
        expect(approvals.length).toBe(1);

        // 1. タスク開始承認
        expect(approvals[0].message).toContain('タスク開始確認');
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
  // テスト 4: 通常フローの通知内容
  // -------------------------------------------------------------------------
  describe('通常フローの通知内容', () => {
    it(
      'ローカルオンリー通知は送信されず通常の完了通知が送信される',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(false);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ローカルオンリー通知がないこと
        const localOnlyNotification = notifier.notifications.find((n) =>
          n.message.includes('ローカルオンリーモード'),
        );
        expect(localOnlyNotification).toBeUndefined();

        // タスク完了（ローカルオンリー）通知がないこと
        const localOnlyDone = notifier.notifications.find((n) =>
          n.message.includes('タスク完了（ローカルオンリー）'),
        );
        expect(localOnlyDone).toBeUndefined();

        // 通常のタスク完了通知があること
        const taskDone = notifier.notifications.find((n) =>
          n.message.includes('タスク完了') && !n.message.includes('ローカルオンリー'),
        );
        expect(taskDone).toBeDefined();

        // ストーリー完了通知があること
        const storyDone = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(storyDone).toBeDefined();
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
  // テスト 5: 複数タスクの通常フロー
  // -------------------------------------------------------------------------
  describe('複数タスクの通常フロー', () => {
    it(
      '全タスクが Done かつ mode なし（通常記録）で完了する',
      withVault(async (vault) => {
        mockDetectNoRemote.mockReturnValue(false);

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 全タスクが Done
        for (const taskPath of vault.taskFilePaths) {
          const fm = readFrontmatter(taskPath);
          expect(fm.status).toBe('Done');
          // mode が設定されていない（通常フロー）
          expect(fm.mode).toBeUndefined();
          // pr が設定されている
          expect(fm.pr).toBeTruthy();
        }

        // ストーリーが Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // runAgent が 5 回呼ばれた（タスク2つ × (implementation + doc-update) + story-doc-update）
        expect(deps.runAgent).toHaveBeenCalledTimes(5);

        // syncMainBranch が 3 回呼ばれた（タスク2つ + story-doc-update）
        expect(deps.syncMainBranch).toHaveBeenCalledTimes(3);

        // recordTaskCompletion が 2 回呼ばれた
        expect(deps.recordTaskCompletion).toHaveBeenCalledTimes(2);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-first`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-second`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );
  });
});
