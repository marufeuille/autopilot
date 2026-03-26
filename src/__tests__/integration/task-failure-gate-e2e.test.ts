import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps } from '../helpers/fake-deps';
import { runStory } from '../../runner';
import { readStoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus, recordTaskCompletion, TaskCompletionRecord } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';

// detectNoRemote をモック化（テスト環境では remote なしと判定されるため）
vi.mock('../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git')>();
  return { ...actual, detectNoRemote: vi.fn().mockReturnValue(false) };
});

// runMergePollingLoop をモック化
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

// ---------------------------------------------------------------------------
// Helper: 状態遷移を追跡する updateFileStatus
// ---------------------------------------------------------------------------
function createTrackingUpdateFileStatus(): {
  transitions: Array<{ slug: string; status: string }>;
  fn: (filePath: string, status: TaskStatus) => void;
  completionFn: (filePath: string, record: TaskCompletionRecord) => void;
} {
  const transitions: Array<{ slug: string; status: string }> = [];
  const fn = (filePath: string, status: TaskStatus) => {
    updateFileStatus(filePath, status);
    const slug = path.basename(filePath, '.md');
    transitions.push({ slug, status });
  };
  const completionFn = (filePath: string, record: TaskCompletionRecord) => {
    recordTaskCompletion(filePath, record);
    const slug = path.basename(filePath, '.md');
    transitions.push({ slug, status: 'Done' });
  };
  return { transitions, fn, completionFn };
}

// ===========================================================================
// Task失敗ゲート E2E テスト
// ===========================================================================
describe('Task失敗ゲート E2E テスト', () => {
  // -------------------------------------------------------------------------
  // シナリオ 1: リトライ — Task失敗 → retry → Todo → 再実行 → Done → Story Done
  // -------------------------------------------------------------------------
  describe('リトライシナリオ', () => {
    const PROJECT = 'retry-e2e-project';
    const STORY_SLUG = 'retry-e2e-story';

    it(
      'Task失敗 → retry選択 → Todoに戻る → 再実行 → Done → Story Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. task-01 start → approve
        //   (task-01 runAgent throws → Failed)
        //   2. task-01 failure action → approve (retry)
        //   3. task-01 start (2nd) → approve
        //   (task-01 runAgent succeeds → pipeline completes → Done)
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
          { action: 'approve' },  // task-01 failure → retry
          { action: 'approve' },  // task-01 start (2nd, after retry)
        );

        // 1回目: agent crash, 2回目以降: 成功
        const runAgentMock = vi.fn()
          .mockRejectedValueOnce(new Error('Agent process crashed'))
          .mockResolvedValue(undefined);

        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスクが最終的に Done
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');

        // ストーリーが Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'リトライ時の状態遷移が Doing → Failed → Todo → Doing → Done の順で記録される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task start
          { action: 'approve' },  // failure → retry
          { action: 'approve' },  // task start (2nd)
        );

        const runAgentMock = vi.fn()
          .mockRejectedValueOnce(new Error('crash'))
          .mockResolvedValue(undefined);

        const { transitions, fn: trackingFn, completionFn } = createTrackingUpdateFileStatus();
        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
          updateFileStatus: vi.fn().mockImplementation(trackingFn),
          recordTaskCompletion: vi.fn().mockImplementation(completionFn),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const taskSlug = `${STORY_SLUG}-01-task`;
        const taskTransitions = transitions.filter((t) => t.slug === taskSlug);

        // Doing (pipeline start) → Failed (catch) → Todo (retry reset) → Doing (pipeline restart) → Done (completion)
        expect(taskTransitions).toEqual([
          { slug: taskSlug, status: 'Doing' },
          { slug: taskSlug, status: 'Failed' },
          { slug: taskSlug, status: 'Todo' },
          { slug: taskSlug, status: 'Doing' },
          { slug: taskSlug, status: 'Done' },
        ]);
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
  // シナリオ 2: スキップ — Task失敗 → skip → Skipped → 次Task → Done → Story Done
  // -------------------------------------------------------------------------
  describe('スキップシナリオ', () => {
    const PROJECT = 'skip-e2e-project';
    const STORY_SLUG = 'skip-e2e-story';

    it(
      'Task失敗 → skip選択 → Skipped → 次Taskが実行されDone → Story Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. task-01 start → approve
        //   (task-01 runAgent throws → Failed)
        //   2. task-01 failure action → reject (skip)
        //   3. task-02 start → approve
        //   (task-02 succeeds → Done)
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'reject', reason: 'skip' },   // task-01 failure → skip
          { action: 'approve' },                  // task-02 start
        );

        // task-01 のみ失敗
        const runAgentMock = vi.fn()
          .mockRejectedValueOnce(new Error('Agent crashed'))
          .mockResolvedValue(undefined);

        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // task-01 が Skipped
        const task01Fm = readFrontmatter(vault.taskFilePaths[0]);
        expect(task01Fm.status).toBe('Skipped');

        // task-02 が Done
        const task02Fm = readFrontmatter(vault.taskFilePaths[1]);
        expect(task02Fm.status).toBe('Done');

        // ストーリーが Done（Skipped + Done = Done）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // シナリオ 3: キャンセル — Task失敗 → cancel → Story Cancelled → 残Task未実行
  // -------------------------------------------------------------------------
  describe('キャンセルシナリオ', () => {
    const PROJECT = 'cancel-e2e-project';
    const STORY_SLUG = 'cancel-e2e-story';

    it(
      'Task失敗 → cancel選択 → Story Cancelled → 残りのTaskが実行されない',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. task-01 start → approve
        //   (task-01 runAgent throws → Failed)
        //   2. task-01 failure action → cancel
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
          { action: 'cancel' },   // task-01 failure → cancel
        );

        const runAgentMock = vi.fn()
          .mockRejectedValueOnce(new Error('Agent crashed'))
          .mockResolvedValue(undefined);

        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ストーリーが Cancelled
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Cancelled');

        // task-02, task-03 は Todo のまま（実行されない）
        const task02Fm = readFrontmatter(vault.taskFilePaths[1]);
        expect(task02Fm.status).toBe('Todo');
        const task03Fm = readFrontmatter(vault.taskFilePaths[2]);
        expect(task03Fm.status).toBe('Todo');

        // キャンセル通知が送信される
        const cancelNotification = notifier.notifications.find((n) =>
          n.message.includes('キャンセル'),
        );
        expect(cancelNotification).toBeDefined();

        // runAgent は1回だけ呼ばれる（task-01 のみ）
        expect(runAgentMock).toHaveBeenCalledTimes(1);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
          { slug: `${STORY_SLUG}-03-task`, status: 'Todo', priority: 'low' },
        ],
      }),
    );

    it(
      'キャンセル後にスレッドセッションが終了する',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
          { action: 'cancel' },   // task-01 failure → cancel
        );

        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('crash')),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // スレッドセッションが終了している（thread_ts が undefined）
        expect(notifier.getThreadTs(STORY_SLUG)).toBeUndefined();
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // シナリオ 4: 複合 — Task1成功 → Task2失敗→retry→成功 → Task3失敗→skip → Story Done
  // -------------------------------------------------------------------------
  describe('複合シナリオ', () => {
    const PROJECT = 'compound-e2e-project';
    const STORY_SLUG = 'compound-e2e-story';

    it(
      'Task1成功 → Task2失敗→retry→成功 → Task3失敗→skip → Story Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. task-01 start → approve        (task-01 succeeds)
        //   2. task-02 start → approve        (task-02 runAgent throws)
        //   3. task-02 failure → approve (retry)
        //   4. task-02 start (2nd) → approve  (task-02 succeeds)
        //   5. task-03 start → approve        (task-03 runAgent throws)
        //   6. task-03 failure → reject (skip)
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'approve' },                  // task-02 start
          { action: 'approve' },                  // task-02 failure → retry
          { action: 'approve' },                  // task-02 start (2nd)
          { action: 'approve' },                  // task-03 start
          { action: 'reject', reason: 'skip' },   // task-03 failure → skip
        );

        // runAgent 呼び出し制御（pipeline は impl + doc-update で2回ずつ呼ぶ）:
        //   call 1: task-01 impl → 成功
        //   call 2: task-01 doc-update → 成功
        //   call 3: task-02 impl (1st) → crash
        //   (retry)
        //   call 4: task-02 impl (2nd) → 成功
        //   call 5: task-02 doc-update → 成功
        //   call 6: task-03 impl → crash
        //   (skip — doc-update は呼ばれない)
        //   call 7: story-doc-update → 成功
        const runAgentMock = vi.fn()
          .mockResolvedValueOnce(undefined)        // task-01 impl
          .mockResolvedValueOnce(undefined)        // task-01 doc-update
          .mockRejectedValueOnce(new Error('Task2 crashed'))  // task-02 impl (1st)
          .mockResolvedValueOnce(undefined)        // task-02 impl (2nd, retry)
          .mockResolvedValueOnce(undefined)        // task-02 doc-update
          .mockRejectedValueOnce(new Error('Task3 crashed'))  // task-03 impl
          .mockResolvedValue(undefined);           // story-doc-update + fallback

        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // task-01: Done
        const task01Fm = readFrontmatter(vault.taskFilePaths[0]);
        expect(task01Fm.status).toBe('Done');

        // task-02: Done (retry後に成功)
        const task02Fm = readFrontmatter(vault.taskFilePaths[1]);
        expect(task02Fm.status).toBe('Done');

        // task-03: Skipped
        const task03Fm = readFrontmatter(vault.taskFilePaths[2]);
        expect(task03Fm.status).toBe('Skipped');

        // ストーリーが Done（Done + Done + Skipped = Done）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
          { slug: `${STORY_SLUG}-03-task`, status: 'Todo', priority: 'low' },
        ],
      }),
    );

    it(
      '複合シナリオの状態遷移が正しく記録される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'approve' },                  // task-02 start
          { action: 'approve' },                  // task-02 failure → retry
          { action: 'approve' },                  // task-02 start (2nd)
          { action: 'approve' },                  // task-03 start
          { action: 'reject', reason: 'skip' },   // task-03 failure → skip
        );

        const runAgentMock = vi.fn()
          .mockResolvedValueOnce(undefined)        // task-01 impl
          .mockResolvedValueOnce(undefined)        // task-01 doc-update
          .mockRejectedValueOnce(new Error('Task2 crashed'))  // task-02 impl (1st)
          .mockResolvedValueOnce(undefined)        // task-02 impl (2nd, retry)
          .mockResolvedValueOnce(undefined)        // task-02 doc-update
          .mockRejectedValueOnce(new Error('Task3 crashed'))  // task-03 impl
          .mockResolvedValue(undefined);           // story-doc-update + fallback

        const { transitions, fn: trackingFn, completionFn } = createTrackingUpdateFileStatus();
        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
          updateFileStatus: vi.fn().mockImplementation(trackingFn),
          recordTaskCompletion: vi.fn().mockImplementation(completionFn),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // task-01: Doing → Done
        const t01 = `${STORY_SLUG}-01-task`;
        const t01Transitions = transitions.filter((t) => t.slug === t01);
        expect(t01Transitions).toEqual([
          { slug: t01, status: 'Doing' },
          { slug: t01, status: 'Done' },
        ]);

        // task-02: Doing → Failed → Todo → Doing → Done
        const t02 = `${STORY_SLUG}-02-task`;
        const t02Transitions = transitions.filter((t) => t.slug === t02);
        expect(t02Transitions).toEqual([
          { slug: t02, status: 'Doing' },
          { slug: t02, status: 'Failed' },
          { slug: t02, status: 'Todo' },
          { slug: t02, status: 'Doing' },
          { slug: t02, status: 'Done' },
        ]);

        // task-03: Doing → Failed → Skipped
        const t03 = `${STORY_SLUG}-03-task`;
        const t03Transitions = transitions.filter((t) => t.slug === t03);
        expect(t03Transitions).toEqual([
          { slug: t03, status: 'Doing' },
          { slug: t03, status: 'Failed' },
          { slug: t03, status: 'Skipped' },
        ]);

        // ストーリー: Done
        const storyTransitions = transitions.filter((t) => t.slug === STORY_SLUG);
        expect(storyTransitions).toEqual([
          { slug: STORY_SLUG, status: 'Done' },
        ]);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
          { slug: `${STORY_SLUG}-03-task`, status: 'Todo', priority: 'low' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // シナリオ 5: 全Task失敗 — 全TaskがFailed/Skippedで終了 → Storyステータスが適切
  // -------------------------------------------------------------------------
  describe('全Task失敗シナリオ', () => {
    const PROJECT = 'all-fail-e2e-project';
    const STORY_SLUG = 'all-fail-e2e-story';

    it(
      '全Taskスキップ → Story Done（Skippedはユーザー意図的判断のためDone扱い）',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 全タスク: start → approve, failure → skip
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'reject', reason: 'skip' },   // task-01 failure → skip
          { action: 'approve' },                  // task-02 start
          { action: 'reject', reason: 'skip' },   // task-02 failure → skip
        );

        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('All agents crash')),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 全タスクが Skipped
        const task01Fm = readFrontmatter(vault.taskFilePaths[0]);
        expect(task01Fm.status).toBe('Skipped');
        const task02Fm = readFrontmatter(vault.taskFilePaths[1]);
        expect(task02Fm.status).toBe('Skipped');

        // 全 Skipped → Story Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );

    it(
      'Task1キャンセル → Story Cancelled（Cancelled > Failed > Done の優先度）',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
          { action: 'cancel' },   // task-01 failure → cancel
        );

        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('crash')),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // Story は Cancelled（ユーザーの明示的中止意思）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Cancelled');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // シナリオ 6: Slack通知がストーリースレッドに投稿される（thread_ts 検証）
  // -------------------------------------------------------------------------
  describe('Slack通知のスレッド投稿検証', () => {
    const PROJECT = 'thread-e2e-project';
    const STORY_SLUG = 'thread-e2e-story';

    it(
      'Task失敗時の承認リクエストがストーリースレッドに紐付く（storySlug が渡される）',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'reject', reason: 'skip' },   // task-01 failure → skip
        );

        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('crash')),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // スレッドセッションが開始されたこと
        expect(notifier.threadStarts).toHaveLength(1);
        expect(notifier.threadStarts[0].storySlug).toBe(STORY_SLUG);

        // Task失敗時の承認リクエストが storySlug 付きで送信されている
        const failureApproval = notifier.approvalRequests.find((r) =>
          r.message.includes('タスク失敗'),
        );
        expect(failureApproval).toBeDefined();
        expect(failureApproval!.storySlug).toBe(STORY_SLUG);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'Task失敗通知にエラーメッセージ・タスク名・ストーリー名が含まれる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'reject', reason: 'skip' },   // task-01 failure → skip
        );

        const errorMessage = 'Something went terribly wrong';
        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error(errorMessage)),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 失敗承認リクエストの内容を検証
        const failureApproval = notifier.approvalRequests.find((r) =>
          r.message.includes('タスク失敗'),
        );
        expect(failureApproval).toBeDefined();
        expect(failureApproval!.message).toContain(`${STORY_SLUG}-01-task`);
        expect(failureApproval!.message).toContain(STORY_SLUG);
        expect(failureApproval!.message).toContain(errorMessage);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'キャンセル通知がストーリースレッドに投稿される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
          { action: 'cancel' },   // task-01 failure → cancel
        );

        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('crash')),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // キャンセル通知が storySlug 付きで送信されている
        const cancelNotification = notifier.notifications.find((n) =>
          n.message.includes('キャンセル'),
        );
        expect(cancelNotification).toBeDefined();
        expect(cancelNotification!.storySlug).toBe(STORY_SLUG);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      '複数回の失敗判断時にすべての承認リクエストがスレッドに紐付く',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // task-01: 失敗 → skip, task-02: 失敗 → skip
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'reject', reason: 'skip' },   // task-01 failure → skip
          { action: 'approve' },                  // task-02 start
          { action: 'reject', reason: 'skip' },   // task-02 failure → skip
        );

        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('crash')),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 失敗承認リクエストが2回送信されている
        const failureApprovals = notifier.approvalRequests.filter((r) =>
          r.message.includes('タスク失敗'),
        );
        expect(failureApprovals).toHaveLength(2);
        // すべてが storySlug 付き（スレッドに紐付く）
        for (const approval of failureApprovals) {
          expect(approval.storySlug).toBe(STORY_SLUG);
        }
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-task`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );
  });
});
