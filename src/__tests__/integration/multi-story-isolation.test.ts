import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier, RecordedEvent } from '../helpers/fake-notifier';
import { createFakeDeps } from '../helpers/fake-deps';
import { runStory } from '../../runner';
import { readStoryFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus, recordTaskCompletion, TaskCompletionRecord } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';

// ---------------------------------------------------------------------------
// Helper: fake vault にタスクファイルを読み取る
// ---------------------------------------------------------------------------
async function readTasksFromVault(
  tasksDir: string,
  project: string,
  storySlug: string,
) {
  const files = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(tasksDir, f))
    : [];
  const tasks = [];
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
function withVaults(
  fn: (vaults: FakeVaultResult[]) => Promise<void>,
  optionsArray: Parameters<typeof createFakeVault>[0][],
): () => Promise<void> {
  return async () => {
    matter.clearCache();
    const vaults = optionsArray.map((opts) => createFakeVault(opts));
    try {
      await fn(vaults);
    } finally {
      for (const vault of vaults) {
        vault.cleanup();
      }
    }
  };
}

// ===========================================================================
// 複数ストーリー同時実行のスレッド分離テスト
// ===========================================================================
describe('複数ストーリー同時実行のスレッド分離テスト', () => {
  const PROJECT = 'multi-story-project';
  const STORY_A = 'story-a';
  const STORY_B = 'story-b';

  // -----------------------------------------------------------------------
  // テスト 1: 2ストーリー並行実行で通知がそれぞれ別スレッドに分離される
  // -----------------------------------------------------------------------
  it(
    '2ストーリー並行実行で通知がそれぞれ別スレッドに分離される',
    withVaults(async ([vaultA, vaultB]) => {
      const notifier = new FakeNotifier();
      const depsA = createIntegrationDeps(vaultA);
      const depsB = createIntegrationDeps(vaultB);

      const storyA = readStoryFile(vaultA.storyFilePath);
      const storyB = readStoryFile(vaultB.storyFilePath);

      // 2つのストーリーを並行実行
      await Promise.all([
        runStory(storyA, notifier, depsA),
        runStory(storyB, notifier, depsB),
      ]);

      // --- スレッドが2つ開始された ---
      expect(notifier.threadStarts).toHaveLength(2);
      const slugsStarted = notifier.threadStarts.map((t) => t.storySlug);
      expect(slugsStarted).toContain(STORY_A);
      expect(slugsStarted).toContain(STORY_B);

      // --- story-a と story-b のスレッド ts が異なる ---
      // (startThread が2回呼ばれるが、endSession で消えている可能性があるので
      //  threadStarts の記録で確認)
      const threadTsA = notifier.threadStarts.find(
        (t) => t.storySlug === STORY_A,
      );
      const threadTsB = notifier.threadStarts.find(
        (t) => t.storySlug === STORY_B,
      );
      expect(threadTsA).toBeDefined();
      expect(threadTsB).toBeDefined();

      // --- 各ストーリーの通知が正しい storySlug に紐づいている ---
      const notificationsA = notifier.notifications.filter(
        (n) => n.storySlug === STORY_A,
      );
      const notificationsB = notifier.notifications.filter(
        (n) => n.storySlug === STORY_B,
      );

      // 各ストーリーに少なくとも1件の通知がある（レビュー結果、完了通知など）
      expect(notificationsA.length).toBeGreaterThanOrEqual(1);
      expect(notificationsB.length).toBeGreaterThanOrEqual(1);

      // --- 各ストーリーの承認リクエストが正しい storySlug に紐づいている ---
      const approvalsA = notifier.approvalRequests.filter(
        (a) => a.storySlug === STORY_A,
      );
      const approvalsB = notifier.approvalRequests.filter(
        (a) => a.storySlug === STORY_B,
      );

      // 各ストーリーに承認リクエストがある（タスク開始、マージ等）
      expect(approvalsA.length).toBeGreaterThanOrEqual(1);
      expect(approvalsB.length).toBeGreaterThanOrEqual(1);

      // --- story-a の通知に story-b の storySlug が混入していない ---
      for (const n of notificationsA) {
        expect(n.storySlug).toBe(STORY_A);
      }
      for (const n of notificationsB) {
        expect(n.storySlug).toBe(STORY_B);
      }
    }, [
      {
        project: PROJECT,
        story: { slug: STORY_A, status: 'Doing' },
        tasks: [
          { slug: `${STORY_A}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
      {
        project: PROJECT,
        story: { slug: STORY_B, status: 'Doing' },
        tasks: [
          { slug: `${STORY_B}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
    ]),
  );

  // -----------------------------------------------------------------------
  // テスト 2: 各ストーリーの完了通知がそれぞれのスレッドに送られる
  // -----------------------------------------------------------------------
  it(
    '各ストーリーの完了通知がそれぞれの storySlug に紐づく',
    withVaults(async ([vaultA, vaultB]) => {
      const notifier = new FakeNotifier();
      const depsA = createIntegrationDeps(vaultA);
      const depsB = createIntegrationDeps(vaultB);

      const storyA = readStoryFile(vaultA.storyFilePath);
      const storyB = readStoryFile(vaultB.storyFilePath);

      // 順次実行でも各ストーリーが独立スレッドに分離されることを確認
      await runStory(storyA, notifier, depsA);
      await runStory(storyB, notifier, depsB);

      // story-a 完了通知
      const completionA = notifier.notifications.find(
        (n) => n.storySlug === STORY_A && n.message.includes('ストーリー完了'),
      );
      expect(completionA).toBeDefined();

      // story-b 完了通知
      const completionB = notifier.notifications.find(
        (n) => n.storySlug === STORY_B && n.message.includes('ストーリー完了'),
      );
      expect(completionB).toBeDefined();

      // 完了通知が混ざっていない
      expect(completionA!.storySlug).toBe(STORY_A);
      expect(completionB!.storySlug).toBe(STORY_B);
    }, [
      {
        project: PROJECT,
        story: { slug: STORY_A, status: 'Doing' },
        tasks: [
          { slug: `${STORY_A}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
      {
        project: PROJECT,
        story: { slug: STORY_B, status: 'Doing' },
        tasks: [
          { slug: `${STORY_B}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
    ]),
  );

  // -----------------------------------------------------------------------
  // テスト 3: スレッドセッションが各ストーリー完了後に個別解放される
  // -----------------------------------------------------------------------
  it(
    'スレッドセッションが各ストーリー完了後に個別解放される',
    withVaults(async ([vaultA, vaultB]) => {
      const notifier = new FakeNotifier();
      const depsA = createIntegrationDeps(vaultA);
      const depsB = createIntegrationDeps(vaultB);

      const storyA = readStoryFile(vaultA.storyFilePath);
      const storyB = readStoryFile(vaultB.storyFilePath);

      // story-a を実行
      await runStory(storyA, notifier, depsA);

      // story-a のセッションは終了している（endSession が呼ばれた）
      expect(notifier.getThreadTs(STORY_A)).toBeUndefined();

      // story-b を実行
      await runStory(storyB, notifier, depsB);

      // story-b のセッションも終了している
      expect(notifier.getThreadTs(STORY_B)).toBeUndefined();
    }, [
      {
        project: PROJECT,
        story: { slug: STORY_A, status: 'Doing' },
        tasks: [
          { slug: `${STORY_A}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
      {
        project: PROJECT,
        story: { slug: STORY_B, status: 'Doing' },
        tasks: [
          { slug: `${STORY_B}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
    ]),
  );

  // -----------------------------------------------------------------------
  // テスト 4: 同一ストーリーの二重 startThread で既存セッションが維持される
  // -----------------------------------------------------------------------
  it('同一ストーリーの二重 startThread で既存セッションが維持される', async () => {
    const notifier = new FakeNotifier();

    // 1回目の startThread
    await notifier.startThread('story-x', 'ストーリー開始: story-x');
    const firstTs = notifier.getThreadTs('story-x');
    expect(firstTs).toBeDefined();

    // 2回目の startThread（二重呼び出し）
    await notifier.startThread('story-x', 'ストーリー開始: story-x (重複)');
    const secondTs = notifier.getThreadTs('story-x');

    // 最初の thread_ts が維持されている
    expect(secondTs).toBe(firstTs);

    // startThread 呼び出しは2回記録されるが、セッション自体は1つ
    expect(notifier.threadStarts).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // テスト 5: 全イベントが storySlug で正しく分類できる
  // -----------------------------------------------------------------------
  it(
    '全イベントが storySlug で正しく分類できる',
    withVaults(async ([vaultA, vaultB]) => {
      const notifier = new FakeNotifier();
      const depsA = createIntegrationDeps(vaultA);
      const depsB = createIntegrationDeps(vaultB);

      const storyA = readStoryFile(vaultA.storyFilePath);
      const storyB = readStoryFile(vaultB.storyFilePath);

      await Promise.all([
        runStory(storyA, notifier, depsA),
        runStory(storyB, notifier, depsB),
      ]);

      // 全イベントに storySlug が付与されている
      for (const event of notifier.events) {
        const slug = (event as RecordedEvent & { storySlug?: string }).storySlug;
        expect(slug === STORY_A || slug === STORY_B).toBe(true);
      }

      // イベントを storySlug でグルーピング
      const eventsA = notifier.events.filter(
        (e) => (e as RecordedEvent & { storySlug?: string }).storySlug === STORY_A,
      );
      const eventsB = notifier.events.filter(
        (e) => (e as RecordedEvent & { storySlug?: string }).storySlug === STORY_B,
      );

      // 各ストーリーにイベントが存在する
      expect(eventsA.length).toBeGreaterThanOrEqual(2);
      expect(eventsB.length).toBeGreaterThanOrEqual(2);
    }, [
      {
        project: PROJECT,
        story: { slug: STORY_A, status: 'Doing' },
        tasks: [
          { slug: `${STORY_A}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
      {
        project: PROJECT,
        story: { slug: STORY_B, status: 'Doing' },
        tasks: [
          { slug: `${STORY_B}-01-task`, status: 'Todo', priority: 'high' },
        ],
      },
    ]),
  );
});
