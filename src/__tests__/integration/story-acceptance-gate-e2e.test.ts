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
import type { TaskDraft } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';
import type { AcceptanceCheckResult } from '../../story-acceptance-gate';

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
// Helper: 追加タスクファイルを作成する createTaskFile モック
// ---------------------------------------------------------------------------
function createTaskFileImpl(tasksDir: string) {
  return vi.fn().mockImplementation(
    (project: string, storySlug: string, draft: TaskDraft) => {
      const taskFrontmatter = {
        status: 'Todo',
        priority: 'medium',
        effort: 'medium',
        story: storySlug,
        due: null,
        project,
        created: '2026-01-01',
        finished_at: null,
        pr: null,
      };
      const taskContent = `\n# ${draft.title}\n\n## 目的\n\n${draft.purpose}\n\n## 詳細\n\n${draft.detail}\n\n## 完了条件\n\n- [ ] テスト完了条件\n\n## メモ\n\n`;
      const taskFilePath = path.join(tasksDir, `${draft.slug}.md`);
      fs.writeFileSync(taskFilePath, matter.stringify(taskContent, taskFrontmatter));
    },
  );
}

// ===========================================================================
// 受け入れ条件ゲート E2E テスト
// ===========================================================================
describe('受け入れ条件ゲート E2E テスト', () => {
  // -------------------------------------------------------------------------
  // シナリオ 1: 全条件 PASS → Done 選択 → Story Done
  // -------------------------------------------------------------------------
  describe('全条件PASSシナリオ', () => {
    const PROJECT = 'accept-pass-project';
    const STORY_SLUG = 'accept-pass-story';

    it(
      '全条件PASS → Done選択 → ストーリーDone',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー: task-01 start → approve
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
        );
        // 受け入れ条件ゲート: 全PASS → Done
        notifier.enqueueAcceptanceGateResponse({ action: 'done' });

        const checkResult: AcceptanceCheckResult = {
          allPassed: true,
          skipped: false,
          results: [
            { criterion: 'テスト条件1がPASS', result: 'PASS', reason: '実装済み' },
            { criterion: 'テスト条件2がPASS', result: 'PASS', reason: 'テスト通過' },
          ],
        };

        const deps = createIntegrationDeps(vault, {
          checkAcceptanceCriteria: vi.fn().mockResolvedValue(checkResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ストーリーが Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // タスクが Done
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');

        // 受け入れ条件ゲートリクエストが1回送信されている
        expect(notifier.acceptanceGateRequests).toHaveLength(1);
        expect(notifier.acceptanceGateRequests[0].storySlug).toBe(STORY_SLUG);
        expect(notifier.acceptanceGateRequests[0].checkResult.allPassed).toBe(true);
        expect(notifier.acceptanceGateRequests[0].response).toEqual({ action: 'done' });

        // 完了通知が送信されている
        const doneNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(doneNotification).toBeDefined();
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
  // シナリオ 2: 一部 FAIL → force_done → Story Done
  // -------------------------------------------------------------------------
  describe('force_doneシナリオ', () => {
    const PROJECT = 'accept-force-project';
    const STORY_SLUG = 'accept-force-story';

    it(
      '一部FAIL → force_done選択 → ストーリーDone',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
        );
        // 受け入れ条件ゲート: 一部FAIL → force_done
        notifier.enqueueAcceptanceGateResponse({ action: 'force_done' });

        const checkResult: AcceptanceCheckResult = {
          allPassed: false,
          skipped: false,
          results: [
            { criterion: 'ログインAPIが動作する', result: 'PASS', reason: '実装済み' },
            { criterion: 'テストが通る', result: 'FAIL', reason: 'テスト未実装' },
          ],
        };

        const deps = createIntegrationDeps(vault, {
          checkAcceptanceCriteria: vi.fn().mockResolvedValue(checkResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ストーリーが Done（force_done なので）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // 受け入れ条件ゲートリクエストが送信されている
        expect(notifier.acceptanceGateRequests).toHaveLength(1);
        expect(notifier.acceptanceGateRequests[0].checkResult.allPassed).toBe(false);
        expect(notifier.acceptanceGateRequests[0].response).toEqual({ action: 'force_done' });

        // チェック結果に FAIL が含まれている
        const conditions = notifier.acceptanceGateRequests[0].checkResult.conditions;
        expect(conditions).toHaveLength(2);
        expect(conditions.find((c) => !c.passed)).toBeDefined();
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
  // シナリオ 3: 一部 FAIL → コメント → 追加タスク → 承認 → 実行 → 再チェック → 全PASS → Done
  // -------------------------------------------------------------------------
  describe('追加タスクループシナリオ', () => {
    const PROJECT = 'accept-loop-project';
    const STORY_SLUG = 'accept-loop-story';

    it(
      '一部FAIL → コメント → 追加タスク生成 → 承認 → タスク実行 → 再チェック → 全PASS → Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. task-01 start → approve (元タスク実行)
        //   2. 追加タスク案の承認 → approve
        //   3. 追加タスク start → approve (追加タスク実行)
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
          { action: 'approve' },  // 追加タスク案の承認
          { action: 'approve' },  // additional-task start
        );

        // 受け入れ条件ゲート:
        //   1回目: 一部FAIL → コメント
        //   2回目: 全PASS → Done
        notifier.enqueueAcceptanceGateResponse(
          { action: 'comment', text: 'テストを追加してください' },
        );
        notifier.enqueueAcceptanceGateResponse(
          { action: 'done' },
        );

        // 1回目のチェック: 一部 FAIL
        const firstCheckResult: AcceptanceCheckResult = {
          allPassed: false,
          skipped: false,
          results: [
            { criterion: 'ログインAPIが動作する', result: 'PASS', reason: '実装済み' },
            { criterion: 'テストが通る', result: 'FAIL', reason: 'テスト未実装' },
          ],
        };

        // 2回目のチェック: 全 PASS
        const secondCheckResult: AcceptanceCheckResult = {
          allPassed: true,
          skipped: false,
          results: [
            { criterion: 'ログインAPIが動作する', result: 'PASS', reason: '実装済み' },
            { criterion: 'テストが通る', result: 'PASS', reason: 'テスト追加済み' },
          ],
        };

        const checkMock = vi.fn()
          .mockResolvedValueOnce(firstCheckResult)
          .mockResolvedValueOnce(secondCheckResult);

        // 追加タスク案
        const additionalDrafts: TaskDraft[] = [
          {
            slug: `${STORY_SLUG}-02-add-tests`,
            title: 'テスト追加',
            priority: 'high',
            effort: 'medium',
            purpose: 'テストを追加する',
            detail: 'ログインAPIのテストを追加',
            criteria: ['テストが通る'],
          },
        ];

        const createTaskFileMock = createTaskFileImpl(vault.tasksDir);

        const deps = createIntegrationDeps(vault, {
          checkAcceptanceCriteria: checkMock,
          generateAdditionalTasks: vi.fn().mockResolvedValue(additionalDrafts),
          createTaskFile: createTaskFileMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ストーリーが Done
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // 受け入れ条件チェックが2回呼ばれた
        expect(checkMock).toHaveBeenCalledTimes(2);

        // 受け入れ条件ゲートリクエストが2回送信された
        expect(notifier.acceptanceGateRequests).toHaveLength(2);
        // 1回目: 一部FAIL → comment
        expect(notifier.acceptanceGateRequests[0].checkResult.allPassed).toBe(false);
        expect(notifier.acceptanceGateRequests[0].response).toEqual({
          action: 'comment',
          text: 'テストを追加してください',
        });
        // 2回目: 全PASS → done
        expect(notifier.acceptanceGateRequests[1].checkResult.allPassed).toBe(true);
        expect(notifier.acceptanceGateRequests[1].response).toEqual({ action: 'done' });

        // 追加タスクファイルが作成された
        expect(createTaskFileMock).toHaveBeenCalledWith(
          PROJECT,
          STORY_SLUG,
          expect.objectContaining({ slug: `${STORY_SLUG}-02-add-tests` }),
        );

        // 追加タスク案の承認リクエストが送信された
        const additionalTaskApproval = notifier.approvalRequests.find((r) =>
          r.message.includes('追加タスク案'),
        );
        expect(additionalTaskApproval).toBeDefined();
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
  // シナリオ 4: 受け入れ条件なし → スキップして Done
  // -------------------------------------------------------------------------
  describe('受け入れ条件なしスキップシナリオ', () => {
    const PROJECT = 'accept-skip-project';
    const STORY_SLUG = 'accept-skip-story';

    it(
      '受け入れ条件セクションなし → チェックスキップ → ストーリーDone',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
        );

        // 受け入れ条件セクションがない → skipped: true
        const checkResult: AcceptanceCheckResult = {
          allPassed: false,
          skipped: true,
          results: [],
        };

        const deps = createIntegrationDeps(vault, {
          checkAcceptanceCriteria: vi.fn().mockResolvedValue(checkResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ストーリーが Done（チェックスキップ）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // 受け入れ条件ゲートリクエストは送信されない（スキップされた）
        expect(notifier.acceptanceGateRequests).toHaveLength(0);

        // 完了通知は送信される
        const doneNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(doneNotification).toBeDefined();
      }, {
        project: PROJECT,
        story: {
          slug: STORY_SLUG,
          status: 'Doing',
          // 受け入れ条件セクションがないコンテンツ
          content: '\n# テストストーリー\n\n## 概要\n\nテスト\n\n## タスク\n\n## メモ\n\n',
        },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // シナリオ 5: 追加タスク不要コメント → タスク0件 → Done
  // -------------------------------------------------------------------------
  describe('追加タスク不要シナリオ', () => {
    const PROJECT = 'accept-notask-project';
    const STORY_SLUG = 'accept-notask-story';

    it(
      'コメント「追加タスク不要」→ タスク0件生成 → ストーリーDone',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
        );

        // 受け入れ条件ゲート: 一部FAIL → コメント「追加タスク不要」
        notifier.enqueueAcceptanceGateResponse(
          { action: 'comment', text: '追加タスク不要です。現状で問題ありません。' },
        );

        const checkResult: AcceptanceCheckResult = {
          allPassed: false,
          skipped: false,
          results: [
            { criterion: '機能Aが動作する', result: 'PASS', reason: '実装済み' },
            { criterion: '細かい条件B', result: 'FAIL', reason: '未対応だが許容範囲' },
          ],
        };

        const generateMock = vi.fn().mockResolvedValue([]);  // 0件返す

        const deps = createIntegrationDeps(vault, {
          checkAcceptanceCriteria: vi.fn().mockResolvedValue(checkResult),
          generateAdditionalTasks: generateMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // ストーリーが Done（追加タスク不要でDone）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // generateAdditionalTasks が呼ばれた
        expect(generateMock).toHaveBeenCalledTimes(1);
        expect(generateMock).toHaveBeenCalledWith(
          expect.objectContaining({ slug: STORY_SLUG }),
          expect.any(Array),
          '追加タスク不要です。現状で問題ありません。',
          expect.arrayContaining([
            expect.objectContaining({ result: 'FAIL' }),
          ]),
        );

        // 受け入れ条件ゲートリクエストは1回のみ（ループしない）
        expect(notifier.acceptanceGateRequests).toHaveLength(1);

        // 完了通知が送信されている
        const doneNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(doneNotification).toBeDefined();
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
  // シナリオ 6: Slack 通知のスレッド紐付け検証
  // -------------------------------------------------------------------------
  describe('受け入れ条件ゲートの通知検証', () => {
    const PROJECT = 'accept-thread-project';
    const STORY_SLUG = 'accept-thread-story';

    it(
      '受け入れ条件ゲートリクエストがストーリースレッドに紐付く',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
        );
        notifier.enqueueAcceptanceGateResponse({ action: 'done' });

        const checkResult: AcceptanceCheckResult = {
          allPassed: true,
          skipped: false,
          results: [
            { criterion: 'テスト条件', result: 'PASS', reason: '完了' },
          ],
        };

        const deps = createIntegrationDeps(vault, {
          checkAcceptanceCriteria: vi.fn().mockResolvedValue(checkResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // スレッドセッションが開始されたこと
        expect(notifier.threadStarts).toHaveLength(1);
        expect(notifier.threadStarts[0].storySlug).toBe(STORY_SLUG);

        // 受け入れ条件ゲートリクエストがストーリーに紐付いている
        expect(notifier.acceptanceGateRequests).toHaveLength(1);
        expect(notifier.acceptanceGateRequests[0].storySlug).toBe(STORY_SLUG);

        // セッションが終了している
        expect(notifier.getThreadTs(STORY_SLUG)).toBeUndefined();
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'チェック結果の各条件がNotifier経由で正しく伝達される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
        );
        notifier.enqueueAcceptanceGateResponse({ action: 'force_done' });

        const checkResult: AcceptanceCheckResult = {
          allPassed: false,
          skipped: false,
          results: [
            { criterion: '条件A', result: 'PASS', reason: 'OK' },
            { criterion: '条件B', result: 'FAIL', reason: '未実装' },
            { criterion: '条件C', result: 'PASS', reason: 'テスト通過' },
          ],
        };

        const deps = createIntegrationDeps(vault, {
          checkAcceptanceCriteria: vi.fn().mockResolvedValue(checkResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // チェック結果が正しく変換されて通知されている
        const gateReq = notifier.acceptanceGateRequests[0];
        expect(gateReq.checkResult.conditions).toHaveLength(3);
        // PASS 条件
        const passConditions = gateReq.checkResult.conditions.filter((c) => c.passed);
        expect(passConditions).toHaveLength(2);
        // FAIL 条件
        const failConditions = gateReq.checkResult.conditions.filter((c) => !c.passed);
        expect(failConditions).toHaveLength(1);
        expect(failConditions[0].condition).toBe('条件B');
        expect(failConditions[0].reason).toBe('未実装');
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
