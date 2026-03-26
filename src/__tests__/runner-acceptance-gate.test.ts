import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoryFile, TaskFile } from '../vault/reader';
import type { TaskDraft } from '../vault/writer';
import { FakeNotifier } from './helpers/fake-notifier';
import { createFakeDeps } from './helpers/fake-deps';
import type { RunnerDeps } from '../runner-deps';
import type { AcceptanceCheckResult } from '../story-acceptance-gate';

// モック定義
vi.mock('../config', () => ({
  resolveRepoPath: vi.fn((project: string) => `/Users/test/dev/${project}`),
  config: { vaultPath: '/vault' },
  notifyBackend: 'local',
}));

vi.mock('../vault/reader', () => ({
  getStoryTasks: vi.fn(),
}));

vi.mock('../vault/writer', () => ({
  updateFileStatus: vi.fn(),
  createTaskFile: vi.fn(),
  recordTaskCompletion: vi.fn(),
}));

vi.mock('../decomposer', () => ({
  decomposeTasks: vi.fn(),
}));

vi.mock('../notification', () => ({
  generateApprovalId: vi.fn(
    (story: string, task: string) => `${story}--${task}--1`,
  ),
  buildThreadOriginMessage: vi.fn((slug: string) => `スレッド起点: ${slug}`),
}));

vi.mock('../git', () => ({
  syncMainBranch: vi.fn().mockResolvedValue(undefined),
  detectNoRemote: vi.fn().mockReturnValue(true), // README更新をスキップ
  resetNoRemoteCache: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  GitSyncError: class GitSyncError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GitSyncError';
    }
  },
}));

vi.mock('../story-doc-update', () => ({
  runStoryDocUpdate: vi.fn().mockResolvedValue({ skipped: true }),
}));

vi.mock('../merge', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    fetchPullRequestStatus: vi.fn().mockReturnValue({
      state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED',
      statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }),
    runMergePollingLoop: vi.fn().mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 }),
  };
});

vi.mock('../review', () => ({
  runReviewLoop: vi.fn().mockResolvedValue({
    finalVerdict: 'OK', escalationRequired: false,
    iterations: [{ iteration: 1, reviewResult: { verdict: 'OK', summary: 'All good', findings: [] }, timestamp: new Date() }],
    lastReviewResult: { verdict: 'OK', summary: 'All good', findings: [] },
  }),
  formatReviewLoopResult: vi.fn().mockReturnValue('✅ セルフレビュー通過'),
}));

vi.mock('../story-acceptance-gate', () => ({
  checkAcceptanceCriteria: vi.fn(),
  generateAdditionalTasks: vi.fn(),
  defaultQueryAI: vi.fn(),
}));

const mockQuery = vi.fn(() => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
  execFileSync: vi.fn().mockReturnValue(''),
}));

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../ci', () => ({
  runCIPollingLoop: vi.fn().mockResolvedValue({
    finalStatus: 'success', attempts: 1,
    attemptResults: [{ attempt: 1, ciResult: { status: 'success', summary: 'CI passed' }, timestamp: new Date() }],
    lastCIResult: { status: 'success', summary: 'CI passed' },
  }),
  formatCIPollingResult: vi.fn().mockReturnValue('✅ CI通過'),
}));

import { runStory, toNotificationCheckResult } from '../runner';

function createStory(overrides: Partial<StoryFile> = {}): StoryFile {
  return {
    filePath: '/vault/Projects/myproject/stories/my-story.md',
    project: 'myproject',
    slug: 'my-story',
    status: 'Doing',
    frontmatter: { status: 'Doing' },
    content: '# My Story\n\n## 受け入れ条件\n\n- [ ] 機能Aが動作する\n- [ ] テストが通る',
    ...overrides,
  };
}

function createTask(
  slug: string,
  status: string,
  overrides: Partial<TaskFile> = {},
): TaskFile {
  return {
    filePath: `/vault/Projects/myproject/tasks/my-story/${slug}.md`,
    project: 'myproject',
    storySlug: 'my-story',
    slug,
    status: status as TaskFile['status'],
    frontmatter: { status },
    content: `# ${slug}\nTask content`,
    ...overrides,
  };
}

describe('toNotificationCheckResult', () => {
  it('gate の AcceptanceCheckResult を notification の形式に変換する', () => {
    const gateResult: AcceptanceCheckResult = {
      allPassed: false,
      skipped: false,
      results: [
        { criterion: '機能Aが動作する', result: 'PASS', reason: 'PRで実装済み' },
        { criterion: 'テストが通る', result: 'FAIL', reason: 'テスト未実装' },
      ],
    };

    const notificationResult = toNotificationCheckResult(gateResult);

    expect(notificationResult.allPassed).toBe(false);
    expect(notificationResult.conditions).toHaveLength(2);
    expect(notificationResult.conditions[0]).toEqual({
      condition: '機能Aが動作する',
      passed: true,
      reason: 'PRで実装済み',
    });
    expect(notificationResult.conditions[1]).toEqual({
      condition: 'テストが通る',
      passed: false,
      reason: 'テスト未実装',
    });
  });

  it('全条件PASSの場合', () => {
    const gateResult: AcceptanceCheckResult = {
      allPassed: true,
      skipped: false,
      results: [
        { criterion: '条件A', result: 'PASS', reason: 'OK' },
      ],
    };

    const result = toNotificationCheckResult(gateResult);
    expect(result.allPassed).toBe(true);
    expect(result.conditions[0].passed).toBe(true);
  });
});

describe('runStory - 受け入れ条件ゲート', () => {
  let notifier: FakeNotifier;
  let deps: RunnerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    notifier = new FakeNotifier();
    deps = createFakeDeps();
  });

  it('全タスクDone/Skipped後に受け入れ条件チェックが自動起動する', async () => {
    const story = createStory();
    const doneTasks = [
      createTask('task-01', 'Done'),
      createTask('task-02', 'Skipped'),
    ];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: true,
      skipped: false,
      results: [{ criterion: '機能Aが動作する', result: 'PASS', reason: 'OK' }],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'done' });

    await runStory(story, notifier, deps);

    expect(deps.checkAcceptanceCriteria).toHaveBeenCalledWith(
      story, doneTasks, expect.any(String),
    );
  });

  it('全条件PASSで「Done」選択時、ストーリーがDoneになる', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: true,
      skipped: false,
      results: [{ criterion: '条件A', result: 'PASS', reason: 'OK' }],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'done' });

    await runStory(story, notifier, deps);

    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
    expect(notifier.notifications.some(n => n.message.includes('ストーリー完了'))).toBe(true);
  });

  it('一部FAILで「このまま Done にする」選択時、ストーリーがDoneになる', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: false,
      skipped: false,
      results: [
        { criterion: '条件A', result: 'PASS', reason: 'OK' },
        { criterion: '条件B', result: 'FAIL', reason: 'NG' },
      ],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'force_done' });

    await runStory(story, notifier, deps);

    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
    // 受け入れ条件ゲートが呼ばれたことを確認
    expect(notifier.acceptanceGateRequests).toHaveLength(1);
    expect(notifier.acceptanceGateRequests[0].response.action).toBe('force_done');
  });

  it('受け入れ条件セクションがない場合、ゲートをスキップして従来通りDoneになる', async () => {
    const story = createStory({
      content: '# My Story\nStory content without acceptance criteria',
    });
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: true,
      skipped: true,
      results: [],
    });

    await runStory(story, notifier, deps);

    // ゲートアクションは呼ばれない
    expect(notifier.acceptanceGateRequests).toHaveLength(0);
    // ストーリーはDoneになる
    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });

  it('コメント入力→追加タスク承認→タスク実行→再チェックのループが動作する', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];
    const additionalTask = createTask('my-story-fix-01', 'Todo');
    const additionalTaskDone = createTask('my-story-fix-01', 'Done');

    const additionalDraft: TaskDraft = {
      slug: 'my-story-fix-01',
      title: '修正タスク',
      priority: 'high',
      effort: 'low',
      purpose: '条件Bを満たすため',
      detail: '詳細',
      criteria: ['条件Bが通る'],
    };

    // 1回目: 既存タスクのみ
    (deps.getStoryTasks as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(doneTasks)  // 初回タスク取得
      .mockResolvedValueOnce(doneTasks)  // ループ1回目: タスク取得
      .mockResolvedValueOnce(doneTasks)  // ループ1回目: 終端チェック
      .mockResolvedValueOnce([...doneTasks, additionalTask])  // ループ2回目: タスク取得（追加タスクあり）
      .mockResolvedValueOnce([...doneTasks, additionalTaskDone])  // ループ2回目: 終端チェック
      .mockResolvedValueOnce([...doneTasks, additionalTaskDone]); // ループ2回目: 再取得

    // 1回目チェック: 一部FAIL
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        allPassed: false,
        skipped: false,
        results: [
          { criterion: '条件A', result: 'PASS', reason: 'OK' },
          { criterion: '条件B', result: 'FAIL', reason: 'NG' },
        ],
      })
      // 2回目チェック: 全PASS
      .mockResolvedValueOnce({
        allPassed: true,
        skipped: false,
        results: [
          { criterion: '条件A', result: 'PASS', reason: 'OK' },
          { criterion: '条件B', result: 'PASS', reason: '修正済み' },
        ],
      });

    // ユーザーアクション: 1回目はコメント、2回目はDone
    notifier.enqueueAcceptanceGateResponse({ action: 'comment', text: '条件Bのテストを追加して' });
    notifier.enqueueAcceptanceGateResponse({ action: 'done' });

    // 追加タスク生成
    (deps.generateAdditionalTasks as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([additionalDraft]);

    // 追加タスク承認
    notifier.enqueueApprovalResponse({ action: 'approve' });

    await runStory(story, notifier, deps);

    // 追加タスクファイルが作成された
    expect(deps.createTaskFile).toHaveBeenCalledWith(
      story.project, story.slug, additionalDraft,
    );
    // 受け入れ条件チェックが2回呼ばれた
    expect(deps.checkAcceptanceCriteria).toHaveBeenCalledTimes(2);
    // ストーリーがDoneになった
    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });

  it('コメントが「追加タスク不要」の場合、タスク0件でDoneになる', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: false,
      skipped: false,
      results: [
        { criterion: '条件A', result: 'FAIL', reason: 'NG' },
      ],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'comment', text: '追加タスク不要です' });

    (deps.generateAdditionalTasks as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]);

    await runStory(story, notifier, deps);

    // タスクファイル作成は呼ばれない
    expect(deps.createTaskFile).not.toHaveBeenCalled();
    // ストーリーはDoneになる
    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });

  it('追加タスク承認でキャンセルを選択した場合、Doneになる', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    const additionalDraft: TaskDraft = {
      slug: 'my-story-fix-01',
      title: '修正タスク',
      priority: 'high',
      effort: 'low',
      purpose: 'purpose',
      detail: 'detail',
      criteria: ['criterion'],
    };

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: false,
      skipped: false,
      results: [{ criterion: '条件A', result: 'FAIL', reason: 'NG' }],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'comment', text: 'テストを修正して' });

    (deps.generateAdditionalTasks as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([additionalDraft]);

    // 追加タスク承認でキャンセル（Doneにする）
    notifier.enqueueApprovalResponse({ action: 'cancel' });

    await runStory(story, notifier, deps);

    // タスクファイルは作成されない
    expect(deps.createTaskFile).not.toHaveBeenCalled();
    // ストーリーはDoneになる
    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });

  it('Failed/Cancelledタスクがある場合は受け入れ条件ゲートをスキップする', async () => {
    const story = createStory();
    const tasks = [
      createTask('task-01', 'Done'),
      createTask('task-02', 'Failed'),
    ];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(tasks);

    await runStory(story, notifier, deps);

    // 受け入れ条件チェックは呼ばれない
    expect(deps.checkAcceptanceCriteria).not.toHaveBeenCalled();
    // ストーリーはFailedになる
    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Failed');
  });

  it('既存のタスク失敗ゲートとの共存が正しく動作する', async () => {
    const story = createStory();
    const todoTask = createTask('task-01', 'Todo');
    const doneTask = createTask('task-01', 'Done');

    // タスク取得: 初回はTodo、実行後はDone
    (deps.getStoryTasks as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([todoTask])    // 初回
      .mockResolvedValueOnce([todoTask])    // ループ1: タスク取得
      .mockResolvedValueOnce([doneTask]);   // ループ1: 終端チェック

    // タスク実行は成功（mockQuery はデフォルトで成功）

    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: true,
      skipped: false,
      results: [{ criterion: '条件A', result: 'PASS', reason: 'OK' }],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'done' });

    await runStory(story, notifier, deps);

    // タスクが実行された後、受け入れ条件チェックが実行された
    expect(deps.checkAcceptanceCriteria).toHaveBeenCalledTimes(1);
    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });

  it('受け入れ条件ゲートの結果がnotifierに正しい形式で渡される', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: false,
      skipped: false,
      results: [
        { criterion: '機能Aが動作する', result: 'PASS', reason: 'PRで実装済み' },
        { criterion: 'テストが通る', result: 'FAIL', reason: 'テスト未実装' },
      ],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'force_done' });

    await runStory(story, notifier, deps);

    // notifier に渡された checkResult を検証
    const gateReq = notifier.acceptanceGateRequests[0];
    expect(gateReq.checkResult.allPassed).toBe(false);
    expect(gateReq.checkResult.conditions).toHaveLength(2);
    expect(gateReq.checkResult.conditions[0]).toEqual({
      condition: '機能Aが動作する',
      passed: true,
      reason: 'PRで実装済み',
    });
    expect(gateReq.checkResult.conditions[1]).toEqual({
      condition: 'テストが通る',
      passed: false,
      reason: 'テスト未実装',
    });
  });

  it('追加タスク承認で「やり直し」を選択した場合、再生成される', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    const draft1: TaskDraft = {
      slug: 'my-story-fix-01', title: '修正1', priority: 'high',
      effort: 'low', purpose: 'p1', detail: 'd1', criteria: ['c1'],
    };
    const draft2: TaskDraft = {
      slug: 'my-story-fix-02', title: '修正2', priority: 'high',
      effort: 'low', purpose: 'p2', detail: 'd2', criteria: ['c2'],
    };

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: false,
      skipped: false,
      results: [{ criterion: '条件A', result: 'FAIL', reason: 'NG' }],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'comment', text: 'テストを修正して' });

    // 1回目: draft1 → やり直し
    // 2回目: draft2 → キャンセル（Doneにする）
    (deps.generateAdditionalTasks as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([draft1])
      .mockResolvedValueOnce([draft2]);

    notifier.enqueueApprovalResponse({ action: 'reject', reason: 'もっと細かく分けて' });
    notifier.enqueueApprovalResponse({ action: 'cancel' });

    await runStory(story, notifier, deps);

    // generateAdditionalTasks が2回呼ばれた（やり直し理由付き）
    expect(deps.generateAdditionalTasks).toHaveBeenCalledTimes(2);
    // ストーリーはDone（キャンセルでDone）
    expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });
});

describe('runStory - Done 通知の順序と notifyUpdate', () => {
  let notifier: FakeNotifier;
  let deps: RunnerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    notifier = new FakeNotifier();
    deps = createFakeDeps();
  });

  it('Done ボタン押下後、ストーリー完了通知が notifyUpdate で送信される', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: true,
      skipped: false,
      results: [{ criterion: '条件A', result: 'PASS', reason: 'OK' }],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'done' });

    await runStory(story, notifier, deps);

    // notifyUpdate でストーリー完了メッセージが送信されている
    expect(notifier.updatedMessages).toHaveLength(1);
    expect(notifier.updatedMessages[0].message).toContain('ストーリー完了');
    expect(notifier.updatedMessages[0].messageTs).toBeTruthy();
  });

  it('force_done でも notifyUpdate でストーリー完了通知が送信される', async () => {
    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: false,
      skipped: false,
      results: [
        { criterion: '条件A', result: 'PASS', reason: 'OK' },
        { criterion: '条件B', result: 'FAIL', reason: 'NG' },
      ],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'force_done' });

    await runStory(story, notifier, deps);

    // notifyUpdate が使われている
    expect(notifier.updatedMessages).toHaveLength(1);
    expect(notifier.updatedMessages[0].message).toContain('ストーリー完了');
  });

  it('受け入れ条件スキップ時（messageTs なし）は notify で送信される', async () => {
    const story = createStory({
      content: '# My Story\nNo acceptance criteria',
    });
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: true,
      skipped: true,
      results: [],
    });

    await runStory(story, notifier, deps);

    // notifyUpdate は呼ばれない（messageTs がないため notify にフォールバック）
    expect(notifier.updatedMessages).toHaveLength(0);
    // 通常の notify でストーリー完了が送信される
    expect(notifier.notifications.some(n => n.message.includes('ストーリー完了'))).toBe(true);
  });

  it('README 更新 PR 通知 → ストーリー完了通知の順序が正しい', async () => {
    // detectNoRemote を false に設定（README 更新を実行する）
    const { detectNoRemote } = await import('../git');
    (detectNoRemote as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const story = createStory();
    const doneTasks = [createTask('task-01', 'Done')];

    (deps.getStoryTasks as ReturnType<typeof vi.fn>).mockResolvedValue(doneTasks);
    (deps.checkAcceptanceCriteria as ReturnType<typeof vi.fn>).mockResolvedValue({
      allPassed: true,
      skipped: false,
      results: [{ criterion: '条件A', result: 'PASS', reason: 'OK' }],
    });

    notifier.enqueueAcceptanceGateResponse({ action: 'done' });

    await runStory(story, notifier, deps);

    // 全イベントの中でストーリー完了通知が最後に来ることを確認
    const notifyEvents = notifier.notifications;
    const completionIdx = notifyEvents.findIndex(n => n.message.includes('ストーリー完了'));
    expect(completionIdx).toBeGreaterThanOrEqual(0);

    // README スキップ通知がストーリー完了より先に来る
    const readmeIdx = notifyEvents.findIndex(n =>
      n.message.includes('README 更新スキップ') || n.message.includes('README 更新 PR')
    );
    if (readmeIdx >= 0) {
      expect(readmeIdx).toBeLessThan(completionIdx);
    }
  });
});
