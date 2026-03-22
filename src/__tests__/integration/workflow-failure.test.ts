import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps, defaultReviewLoopResult, defaultCIPollingResult } from '../helpers/fake-deps';
import { runStory } from '../../runner';
import { readStoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus, TaskDraft } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';
import { ReviewLoopResult } from '../../review/loop';
import { CIPollingResult } from '../../ci/types';

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

// ---------------------------------------------------------------------------
// Helper: 状態遷移を追跡する updateFileStatus
// ---------------------------------------------------------------------------
function createTrackingUpdateFileStatus(): {
  transitions: Array<{ slug: string; status: string }>;
  fn: (filePath: string, status: TaskStatus) => void;
} {
  const transitions: Array<{ slug: string; status: string }> = [];
  const fn = (filePath: string, status: TaskStatus) => {
    updateFileStatus(filePath, status);
    const slug = path.basename(filePath, '.md');
    transitions.push({ slug, status });
  };
  return { transitions, fn };
}

// ---------------------------------------------------------------------------
// Helper: レビュー NG 結果を生成する
// ---------------------------------------------------------------------------
function createReviewNGResult(escalation: boolean): ReviewLoopResult {
  return {
    finalVerdict: 'NG',
    escalationRequired: escalation,
    iterations: [
      {
        iteration: 1,
        reviewResult: {
          verdict: 'NG',
          summary: 'Critical issues found',
          findings: [
            { severity: 'error', message: 'Missing error handling', file: 'src/main.ts', line: 10 },
          ],
        },
        timestamp: new Date(),
      },
    ],
    lastReviewResult: {
      verdict: 'NG',
      summary: 'Critical issues found',
      findings: [
        { severity: 'error', message: 'Missing error handling', file: 'src/main.ts', line: 10 },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: CI 失敗結果を生成する
// ---------------------------------------------------------------------------
function createCIFailureResult(
  finalStatus: 'failure' | 'max_retries_exceeded' | 'timeout' = 'failure',
): CIPollingResult {
  return {
    finalStatus,
    attempts: 2,
    attemptResults: [
      {
        attempt: 1,
        ciResult: {
          status: 'failure',
          summary: 'Test suite failed',
          failureLogs: 'FAIL src/main.test.ts',
          runUrl: 'https://github.com/test/repo/actions/runs/123',
        },
        timestamp: new Date(),
      },
      {
        attempt: 2,
        ciResult: {
          status: 'failure',
          summary: 'Test suite still failing',
          failureLogs: 'FAIL src/main.test.ts',
          runUrl: 'https://github.com/test/repo/actions/runs/124',
        },
        timestamp: new Date(),
      },
    ],
    lastCIResult: {
      status: 'failure',
      summary: 'Test suite still failing',
      failureLogs: 'FAIL src/main.test.ts',
      runUrl: 'https://github.com/test/repo/actions/runs/124',
    },
  };
}

// ===========================================================================
// 異常系ワークフロー結合テスト
// ===========================================================================
describe('異常系ワークフロー結合テスト', () => {
  // -------------------------------------------------------------------------
  // テスト 1: マージ承認が reject → リトライループ
  // -------------------------------------------------------------------------
  describe('マージ承認が reject → リトライループ', () => {
    const PROJECT = 'merge-retry-project';
    const STORY_SLUG = 'merge-retry-story';

    it(
      'マージ拒否後にリトライし、再度 runAgent → review → PR → approve で完了する',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. タスク開始 → approve
        //   2. マージ承認（1回目）→ reject
        //   3. マージ承認（2回目）→ approve
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                                   // start
          { action: 'reject', reason: 'テストカバレッジ不足' },      // merge 1st → reject
          { action: 'approve' },                                   // merge 2nd → approve
        );

        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // runAgent が 2 回呼ばれる（初回 + リトライ）
        expect(deps.runAgent).toHaveBeenCalledTimes(2);

        // リトライ時のプロンプトに修正理由が含まれる
        const secondCallArgs = (deps.runAgent as ReturnType<typeof vi.fn>).mock.calls[1];
        expect(secondCallArgs[0]).toContain('テストカバレッジ不足');

        // runReviewLoop が 2 回呼ばれる
        expect(deps.runReviewLoop).toHaveBeenCalledTimes(2);

        // マージ承認リクエストが 2 回発行されている
        const mergeApprovals = notifier.approvalRequests.filter((a) =>
          a.message.includes('マージ'),
        );
        expect(mergeApprovals).toHaveLength(2);
        expect(mergeApprovals[0].response).toEqual({ action: 'reject', reason: 'テストカバレッジ不足' });
        expect(mergeApprovals[1].response).toEqual({ action: 'approve' });

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
      '状態遷移の中間ステップが正しい順序で記録される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                              // start
          { action: 'reject', reason: '修正が必要' },          // merge reject
          { action: 'approve' },                              // merge approve
        );

        const { transitions, fn: trackingFn } = createTrackingUpdateFileStatus();
        const deps = createIntegrationDeps(vault, {
          updateFileStatus: vi.fn().mockImplementation(trackingFn),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスクの状態遷移: Doing → Done
        const taskSlug = `${STORY_SLUG}-01-task`;
        const taskTransitions = transitions.filter((t) => t.slug === taskSlug);
        expect(taskTransitions).toEqual([
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
  // テスト 2: レビューループが NG 上限到達 → エスカレーション
  // -------------------------------------------------------------------------
  describe('レビューループが NG 上限到達 → エスカレーション', () => {
    const PROJECT = 'review-escalation-project';
    const STORY_SLUG = 'review-escalation-story';

    it(
      'レビュー NG エスカレーション通知が送られ、タスク完了承認に進む',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. タスク開始 → approve
        //   2. タスク完了確認 → approve（レビューNG後はマージ承認なし、完了確認のみ）
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
          { action: 'approve' },  // done (after escalation)
        );

        const reviewNGResult = createReviewNGResult(true);
        const deps = createIntegrationDeps(vault, {
          runReviewLoop: vi.fn().mockResolvedValue(reviewNGResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // エスカレーション通知が送信された
        const escalationNotification = notifier.notifications.find((n) =>
          n.message.includes('エスカレーション'),
        );
        expect(escalationNotification).toBeDefined();

        // PR が作成されていない（レビュー NG のため）
        expect(deps.execCommand).not.toHaveBeenCalledWith(
          expect.stringContaining('git push'),
          expect.any(String),
        );

        // CI ポーリングが呼ばれていない
        expect(deps.runCIPollingLoop).not.toHaveBeenCalled();

        // タスクが Done（完了承認で approve のため）
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'レビュー NG 後のタスク完了確認で reject → リトライ → 成功',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. start → approve
        //   2. done (1st, after review NG) → reject (やり直し)
        //   3. merge (2nd, after retry with review OK) → approve
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                              // start
          { action: 'reject', reason: '修正してください' },    // done reject
          { action: 'approve' },                              // merge approve (on retry)
        );

        const reviewNGResult = createReviewNGResult(true);
        const reviewOKResult = defaultReviewLoopResult();

        // 1回目: NG, 2回目: OK
        const runReviewLoopMock = vi.fn()
          .mockResolvedValueOnce(reviewNGResult)
          .mockResolvedValueOnce(reviewOKResult);

        const deps = createIntegrationDeps(vault, {
          runReviewLoop: runReviewLoopMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // runAgent が 2 回呼ばれる
        expect(deps.runAgent).toHaveBeenCalledTimes(2);

        // runReviewLoop が 2 回呼ばれる
        expect(deps.runReviewLoop).toHaveBeenCalledTimes(2);

        // タスクが最終的に Done
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'エスカレーション通知にタスクとストーリーの情報が含まれる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
          { action: 'approve' },  // done
        );

        const reviewNGResult = createReviewNGResult(true);
        const deps = createIntegrationDeps(vault, {
          runReviewLoop: vi.fn().mockResolvedValue(reviewNGResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // エスカレーション通知の内容を検証
        const escalationNotification = notifier.notifications.find((n) =>
          n.message.includes('エスカレーション'),
        );
        expect(escalationNotification).toBeDefined();
        // 通知にタスクslugの情報が含まれている
        expect(escalationNotification!.message).toContain(`${STORY_SLUG}-01-task`);
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
  // テスト 3: CI ポーリング失敗 → エスカレーション
  // -------------------------------------------------------------------------
  describe('CI ポーリング失敗 → エスカレーション', () => {
    const PROJECT = 'ci-failure-project';
    const STORY_SLUG = 'ci-failure-story';

    it(
      'CI 失敗時にエスカレーション通知が送られる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. start → approve
        //   2. done (CI 失敗後のタスク完了確認) → approve
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
          { action: 'approve' },  // done
        );

        const ciFailureResult = createCIFailureResult('failure');
        const deps = createIntegrationDeps(vault, {
          runCIPollingLoop: vi.fn().mockResolvedValue(ciFailureResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // CI エスカレーション通知が送信された
        const ciEscalation = notifier.notifications.find((n) =>
          n.message.includes('CI'),
        );
        expect(ciEscalation).toBeDefined();

        // マージ承認リクエストは発行されない（CI 失敗のため）
        const mergeApprovals = notifier.approvalRequests.filter((a) =>
          a.message.includes('マージ'),
        );
        expect(mergeApprovals).toHaveLength(0);

        // タスクが Done（完了確認で approve）
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'CI 失敗後の完了確認で reject → リトライ → CI 成功 → マージ承認で完了',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. start → approve
        //   2. done (CI 失敗後) → reject (やり直し)
        //   3. merge (リトライ後 CI 成功) → approve
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                                // start
          { action: 'reject', reason: 'CI を修正してください' },  // done reject
          { action: 'approve' },                                // merge approve (on retry)
        );

        const ciFailureResult = createCIFailureResult('failure');
        const ciSuccessResult = defaultCIPollingResult();

        // 1回目: CI失敗, 2回目: CI成功
        const runCIMock = vi.fn()
          .mockResolvedValueOnce(ciFailureResult)
          .mockResolvedValueOnce(ciSuccessResult);

        const deps = createIntegrationDeps(vault, {
          runCIPollingLoop: runCIMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // runAgent が 2 回呼ばれる
        expect(deps.runAgent).toHaveBeenCalledTimes(2);

        // runCIPollingLoop が 2 回呼ばれる
        expect(deps.runCIPollingLoop).toHaveBeenCalledTimes(2);

        // マージ承認リクエストが 1 回発行された（2回目の CI 成功時）
        const mergeApprovals = notifier.approvalRequests.filter((a) =>
          a.message.includes('マージ'),
        );
        expect(mergeApprovals).toHaveLength(1);

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
      'CI max_retries_exceeded でもエスカレーション通知が送られる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
          { action: 'approve' },  // done
        );

        const ciMaxRetriesResult = createCIFailureResult('max_retries_exceeded');
        const deps = createIntegrationDeps(vault, {
          runCIPollingLoop: vi.fn().mockResolvedValue(ciMaxRetriesResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // CI エスカレーション通知が送信された
        const ciEscalation = notifier.notifications.find((n) =>
          n.message.includes('CI'),
        );
        expect(ciEscalation).toBeDefined();
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'CI timeout でもエスカレーション通知が送られる',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
          { action: 'approve' },  // done
        );

        const ciTimeoutResult = createCIFailureResult('timeout');
        const deps = createIntegrationDeps(vault, {
          runCIPollingLoop: vi.fn().mockResolvedValue(ciTimeoutResult),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const ciEscalation = notifier.notifications.find((n) =>
          n.message.includes('CI'),
        );
        expect(ciEscalation).toBeDefined();
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
  // テスト 4: エージェント実行が例外 → タスク Failed
  // -------------------------------------------------------------------------
  describe('エージェント実行が例外 → タスク Failed', () => {
    const PROJECT = 'agent-error-project';
    const STORY_SLUG = 'agent-error-story';

    it(
      'runAgent が例外を throw → タスクが Failed に遷移する',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
        );

        const agentError = new Error('Agent process crashed');
        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(agentError),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスクが Failed
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Failed');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'エージェント例外時の状態遷移が Doing → Failed の順で記録される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
        );

        const { transitions, fn: trackingFn } = createTrackingUpdateFileStatus();
        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('crash')),
          updateFileStatus: vi.fn().mockImplementation(trackingFn),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const taskSlug = `${STORY_SLUG}-01-task`;
        const taskTransitions = transitions.filter((t) => t.slug === taskSlug);
        expect(taskTransitions).toEqual([
          { slug: taskSlug, status: 'Doing' },
          { slug: taskSlug, status: 'Failed' },
        ]);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'エージェント例外後もレビューや CI は呼ばれない',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // start
        );

        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValue(new Error('crash')),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        expect(deps.runReviewLoop).not.toHaveBeenCalled();
        expect(deps.runCIPollingLoop).not.toHaveBeenCalled();
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
  // テスト 5: 一部タスク失敗時のストーリー状態
  // -------------------------------------------------------------------------
  describe('一部タスク失敗時のストーリー状態', () => {
    const PROJECT = 'partial-failure-project';
    const STORY_SLUG = 'partial-failure-story';

    it(
      '3タスク中1つが Failed → ストーリーは Done (一部失敗あり)、残りは Skipped',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. task-01 start → approve
        //   (task-01 の runAgent が throw → Failed)
        //   2. task-02 start → reject (スキップ)
        //   3. task-03 start → reject (スキップ)
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'reject', reason: 'skip' },   // task-02 start → skip
          { action: 'reject', reason: 'skip' },   // task-03 start → skip
        );

        // task-01 のみ失敗させる（1回のみ reject して残りは通常動作）
        const runAgentMock = vi.fn()
          .mockRejectedValueOnce(new Error('Agent crashed'))
          .mockResolvedValue(undefined);

        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 各タスクの最終ステータスを確認
        const tasks = await readTasksFromVault(vault.tasksDir, PROJECT, STORY_SLUG);
        expect(tasks).toHaveLength(3);

        const statusMap = Object.fromEntries(tasks.map((t) => [t.slug, readFrontmatter(t.filePath).status]));
        expect(statusMap[`${STORY_SLUG}-01-task`]).toBe('Failed');
        expect(statusMap[`${STORY_SLUG}-02-task`]).toBe('Skipped');
        expect(statusMap[`${STORY_SLUG}-03-task`]).toBe('Skipped');

        // ストーリーは全タスクが terminal なので Done（一部失敗/スキップあり）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // 完了通知に失敗/スキップの情報が含まれている
        const completionNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(completionNotification).toBeDefined();
        expect(completionNotification!.message).toContain('一部スキップ/失敗あり');
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
      '状態遷移の順序が正しく記録される（Failed + Skipped の混在）',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                  // task-01 start
          { action: 'reject', reason: 'skip' },   // task-02 start → skip
          { action: 'reject', reason: 'skip' },   // task-03 start → skip
        );

        const { transitions, fn: trackingFn } = createTrackingUpdateFileStatus();
        const deps = createIntegrationDeps(vault, {
          runAgent: vi.fn().mockRejectedValueOnce(new Error('crash')).mockResolvedValue(undefined),
          updateFileStatus: vi.fn().mockImplementation(trackingFn),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // task-01: Doing → Failed
        const task01 = transitions.filter((t) => t.slug === `${STORY_SLUG}-01-task`);
        expect(task01).toEqual([
          { slug: `${STORY_SLUG}-01-task`, status: 'Doing' },
          { slug: `${STORY_SLUG}-01-task`, status: 'Failed' },
        ]);

        // task-02: Skipped
        const task02 = transitions.filter((t) => t.slug === `${STORY_SLUG}-02-task`);
        expect(task02).toEqual([
          { slug: `${STORY_SLUG}-02-task`, status: 'Skipped' },
        ]);

        // task-03: Skipped
        const task03 = transitions.filter((t) => t.slug === `${STORY_SLUG}-03-task`);
        expect(task03).toEqual([
          { slug: `${STORY_SLUG}-03-task`, status: 'Skipped' },
        ]);

        // 全体の順序: task-01 の Doing/Failed が先、task-02/03 の Skipped が後
        const task01FailedIdx = transitions.findIndex(
          (t) => t.slug === `${STORY_SLUG}-01-task` && t.status === 'Failed',
        );
        const task02SkippedIdx = transitions.findIndex(
          (t) => t.slug === `${STORY_SLUG}-02-task` && t.status === 'Skipped',
        );
        expect(task01FailedIdx).toBeLessThan(task02SkippedIdx);
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
      '失敗タスク以外が正常完了した場合もストーリーは Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 承認キュー:
        //   1. task-01 start → approve (→ runAgent throw → Failed)
        //   2. task-02 start → approve
        //   3. task-02 merge → approve
        //   4. task-03 start → approve
        //   5. task-03 merge → approve
        notifier.enqueueApprovalResponse(
          { action: 'approve' },  // task-01 start
          { action: 'approve' },  // task-02 start
          { action: 'approve' },  // task-02 merge
          { action: 'approve' },  // task-03 start
          { action: 'approve' },  // task-03 merge
        );

        const runAgentMock = vi.fn()
          .mockRejectedValueOnce(new Error('task-01 crashed'))
          .mockResolvedValue(undefined);

        const deps = createIntegrationDeps(vault, {
          runAgent: runAgentMock,
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const tasks = await readTasksFromVault(vault.tasksDir, PROJECT, STORY_SLUG);
        const statusMap = Object.fromEntries(tasks.map((t) => [t.slug, readFrontmatter(t.filePath).status]));

        expect(statusMap[`${STORY_SLUG}-01-task`]).toBe('Failed');
        expect(statusMap[`${STORY_SLUG}-02-task`]).toBe('Done');
        expect(statusMap[`${STORY_SLUG}-03-task`]).toBe('Done');

        // ストーリーは Done（全タスクが terminal）
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // 完了通知に一部失敗の情報が含まれる
        const completionNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(completionNotification).toBeDefined();
        expect(completionNotification!.message).toContain('一部スキップ/失敗あり');
        expect(completionNotification!.message).toContain('Failed');
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
  // テスト 6: タスク開始をスキップした場合
  // -------------------------------------------------------------------------
  describe('タスク開始スキップ', () => {
    const PROJECT = 'skip-project';
    const STORY_SLUG = 'skip-story';

    it(
      'タスク開始承認で reject → タスクが Skipped に遷移し、エージェントは実行されない',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'reject', reason: 'not needed' },  // start → reject
        );

        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスクが Skipped
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Skipped');

        // runAgent は呼ばれない
        expect(deps.runAgent).not.toHaveBeenCalled();

        // レビュー、CI も呼ばれない
        expect(deps.runReviewLoop).not.toHaveBeenCalled();
        expect(deps.runCIPollingLoop).not.toHaveBeenCalled();
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
