/**
 * マージフロー全体の E2E テスト（手動マージ + ポーリング）
 *
 * CI通過後にマージ準備完了通知 → ユーザーが手動マージ → MERGED検知で次ステップへ進む
 * 一連のフローを結合テストでカバーする。
 *
 * シナリオ:
 * 1. マージ成功フロー: CI通過 → マージ準備完了通知 → MERGED検知 → タスク Done
 * 2. PRクローズフロー: CLOSED検知 → implementationからリトライ
 * 3. CI失敗フロー: CI失敗 → implementationからリトライ
 * 4. 複数タスクフロー: 各タスクでポーリングが実行される
 * 5. 通知順序: マージ準備完了 → マージ完了の順で通知される
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps, defaultCIPollingResult } from '../helpers/fake-deps';
import { runStory } from '../../runner';
import { readStoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus, recordTaskCompletion, TaskCompletionRecord } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';

// detectNoRemote をモック化（テスト環境では remote なしと判定されるため）
vi.mock('../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git')>();
  return { ...actual, detectNoRemote: vi.fn().mockReturnValue(false) };
});

// runMergePollingLoop をモック化（実際のポーリングループを回さない）
const { mockRunMergePollingLoop } = vi.hoisted(() => ({
  mockRunMergePollingLoop: vi.fn().mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 }),
}));
vi.mock('../../merge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../merge')>();
  return {
    ...actual,
    runMergePollingLoop: (...args: unknown[]) => mockRunMergePollingLoop(...args),
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
    mockRunMergePollingLoop.mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 });
    const vault = createFakeVault(options);
    try {
      await fn(vault);
    } finally {
      vault.cleanup();
    }
  };
}

// ===========================================================================
// マージフロー E2E テスト（手動マージ + ポーリング）
// ===========================================================================
describe('マージフロー E2E テスト', () => {
  const PROJECT = 'merge-test-project';
  const STORY_SLUG = 'merge-test-story';
  const TASK_SLUG = `${STORY_SLUG}-01-task`;
  const PR_URL = 'https://github.com/test/repo/pull/1';

  // =========================================================================
  // 1. マージ成功フロー（手動マージ → MERGED検知）
  // =========================================================================
  describe('マージ成功フロー', () => {
    it(
      'CI通過 → マージ準備完了通知 → MERGED検知 → タスク Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // --- マージ準備完了通知が送信されたこと ---
        const mergeReadyNotification = notifier.notifications.find((n) =>
          n.message.includes('マージ準備完了'),
        );
        expect(mergeReadyNotification).toBeDefined();
        expect(mergeReadyNotification!.message).toContain('GitHubから手動でマージしてください');

        // --- マージ完了通知が送信されたこと ---
        const mergeCompletedNotification = notifier.notifications.find((n) =>
          n.message.includes('マージ完了'),
        );
        expect(mergeCompletedNotification).toBeDefined();
        expect(mergeCompletedNotification!.message).toContain(PR_URL);

        // --- タスクが Done になっていること ---
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');

        // --- ストーリーが Done になっていること ---
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // --- マージ承認（requestApproval）は不要 ---
        const mergeApprovals = notifier.approvalRequests.filter((a) =>
          a.message.includes('マージ'),
        );
        expect(mergeApprovals).toHaveLength(0);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'マージ成功後、通知イベントの順序が正しいこと',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const events = notifier.events;

        // 1. タスク開始承認
        expect(events[0].type).toBe('requestApproval');
        expect((events[0] as { message: string }).message).toContain('タスク開始確認');

        // マージ準備完了 → マージ完了の順序を検証
        const eventMessages = events.map((e) => {
          if (e.type === 'notify') return (e as { message: string }).message;
          if (e.type === 'requestApproval') return (e as { message: string }).message;
          return '';
        });

        const mergeReadyIdx = eventMessages.findIndex((m) => m.includes('マージ準備完了'));
        const completedIdx = eventMessages.findIndex((m) => m.includes('マージ完了'));

        expect(mergeReadyIdx).toBeGreaterThan(-1);
        expect(completedIdx).toBeGreaterThan(mergeReadyIdx);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'タスク開始承認のみが要求されること（マージ承認なし）',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスク開始承認のみ（マージ承認なし）
        expect(notifier.approvalRequests).toHaveLength(1);
        expect(notifier.approvalRequests[0].message).toContain('タスク開始確認');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 2. PRクローズフロー
  // =========================================================================
  describe('PRクローズフロー', () => {
    it(
      'PRがCLOSED（未マージ）の場合にimplementationからリトライされる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
        );

        // 1回目はCLOSED、2回目以降はMERGED
        mockRunMergePollingLoop
          .mockResolvedValueOnce({ finalStatus: 'closed', elapsedMs: 3000 })
          .mockResolvedValueOnce({ finalStatus: 'merged', elapsedMs: 1000 });

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // PRクローズ通知が送信されたこと
        const closeNotification = notifier.notifications.find((n) =>
          n.message.includes('PRクローズ検知'),
        );
        expect(closeNotification).toBeDefined();

        // 最終的にタスクが Done になること
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 3. CI失敗フロー
  // =========================================================================
  describe('CI失敗フロー', () => {
    it(
      'CI未通過時に通知が送信されimplementationからリトライされる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
        );

        // CIポーリングが1回目は失敗、2回目以降は成功
        const deps = createIntegrationDeps(vault, {
          runCIPollingLoop: vi.fn()
            .mockResolvedValueOnce({
              finalStatus: 'failure' as const,
              attempts: 1,
              attemptResults: [
                { attempt: 1, ciResult: { status: 'failure', summary: 'CI failed' }, timestamp: new Date() },
              ],
              lastCIResult: { status: 'failure', summary: 'CI failed' },
            })
            .mockResolvedValue(defaultCIPollingResult()),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // CI未通過通知が送信されたこと
        const ciNotification = notifier.notifications.find((n) =>
          n.message.includes('CI未通過'),
        );
        expect(ciNotification).toBeDefined();
        expect(ciNotification!.message).toContain(TASK_SLUG);

        // 最終的にタスクが Done になること
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 4. 複数タスクのマージフロー
  // =========================================================================
  describe('複数タスクのマージフロー', () => {
    it(
      '各タスクでポーリングが実行され全タスクが Done になること',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 全タスクが Done
        for (const taskPath of vault.taskFilePaths) {
          const fm = readFrontmatter(taskPath);
          expect(fm.status).toBe('Done');
        }

        // ストーリーが Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // ポーリングがタスク数分呼ばれたこと（テスト内での呼び出し回数）
        // recordTaskCompletion がタスク数分呼ばれたことで確認
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

  // =========================================================================
  // 5. タイムアウトフロー
  // =========================================================================
  describe('タイムアウトフロー', () => {
    it(
      'マージ待機タイムアウト時にimplementationからリトライされる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
        );

        // 1回目はタイムアウト、2回目はMERGED
        mockRunMergePollingLoop
          .mockResolvedValueOnce({ finalStatus: 'timeout', elapsedMs: 86400000 })
          .mockResolvedValueOnce({ finalStatus: 'merged', elapsedMs: 1000 });

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タイムアウト通知が送信されたこと
        const timeoutNotification = notifier.notifications.find((n) =>
          n.message.includes('タイムアウト'),
        );
        expect(timeoutNotification).toBeDefined();

        // 最終的にタスクが Done になること
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });
});
