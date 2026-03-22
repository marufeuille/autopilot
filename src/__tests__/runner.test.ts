import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoryFile, TaskFile } from '../vault/reader';
import type { NotificationBackend } from '../notification/types';

// モック定義
vi.mock('../vault/reader', () => ({
  getStoryTasks: vi.fn(),
}));

vi.mock('../vault/writer', () => ({
  updateFileStatus: vi.fn(),
  createTaskFile: vi.fn(),
}));

vi.mock('../decomposer', () => ({
  decomposeTasks: vi.fn(),
}));

vi.mock('../notification', () => ({
  generateApprovalId: vi.fn(
    (story: string, task: string) => `${story}--${task}--1`,
  ),
  buildMergeApprovalMessage: vi.fn((ctx: any) => `マージ承認依頼: ${ctx.taskSlug}`),
  buildReviewEscalationMessage: vi.fn((ctx: any) => `レビューエスカレーション: ${ctx.taskSlug}`),
  buildCIEscalationMessage: vi.fn((ctx: any) => `CIエスカレーション: ${ctx.taskSlug}`),
}));

vi.mock('../git', () => ({
  syncMainBranch: vi.fn().mockResolvedValue(undefined),
  GitSyncError: class GitSyncError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GitSyncError';
    }
  },
}));

// レビューループをモック
const mockRunReviewLoop = vi.fn().mockResolvedValue({
  finalVerdict: 'OK',
  escalationRequired: false,
  iterations: [{ iteration: 1, reviewResult: { verdict: 'OK', summary: 'All good', findings: [] }, timestamp: new Date() }],
  lastReviewResult: { verdict: 'OK', summary: 'All good', findings: [] },
});
const mockFormatReviewLoopResult = vi.fn().mockReturnValue('✅ セルフレビュー通過');
vi.mock('../review', () => ({
  runReviewLoop: (...args: unknown[]) => mockRunReviewLoop(...args),
  formatReviewLoopResult: (...args: unknown[]) => mockFormatReviewLoopResult(...args),
}));

// Claude agent SDK をモック（runTask 内で使われる）
const mockQuery = vi.fn(() => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// child_process の execSync をモック（PR作成・URL取得で使われる）
const mockExecSync = vi.fn(() => '');
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// CIポーリングループをモック
const mockRunCIPollingLoop = vi.fn().mockResolvedValue({
  finalStatus: 'success',
  attempts: 1,
  attemptResults: [{ attempt: 1, ciResult: { status: 'success', summary: 'CI passed' }, timestamp: new Date() }],
  lastCIResult: { status: 'success', summary: 'CI passed' },
});
const mockFormatCIPollingResult = vi.fn().mockReturnValue('✅ CI通過');
vi.mock('../ci', () => ({
  runCIPollingLoop: (...args: unknown[]) => mockRunCIPollingLoop(...args),
  formatCIPollingResult: (...args: unknown[]) => mockFormatCIPollingResult(...args),
}));

import { getStoryTasks } from '../vault/reader';
import { updateFileStatus } from '../vault/writer';
import { decomposeTasks } from '../decomposer';
import { syncMainBranch, GitSyncError } from '../git';
import { runStory, runTask, formatReviewSummaryForPR, createPullRequest } from '../runner';

const mockedGetStoryTasks = vi.mocked(getStoryTasks);
const mockedUpdateFileStatus = vi.mocked(updateFileStatus);
const mockedDecomposeTasks = vi.mocked(decomposeTasks);
const mockedSyncMainBranch = vi.mocked(syncMainBranch);

function createStory(overrides: Partial<StoryFile> = {}): StoryFile {
  return {
    filePath: '/vault/Projects/myproject/stories/my-story.md',
    project: 'myproject',
    slug: 'my-story',
    status: 'Doing',
    frontmatter: { status: 'Doing' },
    content: '# My Story\nStory content',
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

function createMockNotifier(
  approvalAction: 'approve' | 'reject' = 'approve',
): NotificationBackend {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    requestApproval: vi.fn().mockResolvedValue(
      approvalAction === 'approve'
        ? { action: 'approve' }
        : { action: 'reject', reason: 'テスト拒否' },
    ),
  };
}

describe('runStory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('全タスクが Done のとき、Todo が 0 件でもストーリーが Done に更新される', async () => {
    const story = createStory();
    const notifier = createMockNotifier();
    const doneTasks = [
      createTask('task-01', 'Done'),
      createTask('task-02', 'Done'),
      createTask('task-03', 'Done'),
    ];

    // 最初の呼び出し（タスク存在チェック）: タスクあり
    // 2回目の呼び出し（Todo フィルタ用）: 全部 Done
    mockedGetStoryTasks.mockResolvedValue(doneTasks);

    await runStory(story, notifier);

    // ストーリーが Done に更新されること
    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
    // 完了通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('ストーリー完了'),
    );
  });

  it('タスクが存在しない場合は runDecomposition が呼ばれる', async () => {
    const story = createStory();
    const notifier = createMockNotifier();

    // 1回目: タスクなし（decomposition トリガー）
    mockedGetStoryTasks.mockResolvedValueOnce([]);

    // decomposeTasks のモック
    mockedDecomposeTasks.mockResolvedValue([
      {
        slug: 'task-01',
        title: 'Task 1',
        priority: 'high',
        effort: 'low',
        purpose: 'purpose',
        detail: 'detail',
        criteria: ['criterion'],
      },
    ]);

    // 2回目（decomposition 後の再取得）: 作成されたタスク
    const newTask = createTask('task-01', 'Todo');
    mockedGetStoryTasks.mockResolvedValueOnce([newTask]);

    await runStory(story, notifier);

    // decomposeTasks が呼ばれたことを確認
    expect(mockedDecomposeTasks).toHaveBeenCalledWith(story, undefined);
    // 承認リクエストが送信されたことを確認（分解承認 + タスク開始承認 + タスク完了承認）
    expect(notifier.requestApproval).toHaveBeenCalled();
  });

  it('Doing 状態のタスクが残っている場合、ストーリーは Done にならずログが出る', async () => {
    const story = createStory();
    const notifier = createMockNotifier();
    const tasks = [
      createTask('task-01', 'Done'),
      createTask('task-02', 'Doing'),
    ];

    mockedGetStoryTasks.mockResolvedValue(tasks);

    const consoleSpy = vi.spyOn(console, 'log');

    await runStory(story, notifier);

    // ストーリーは Done に更新されないこと
    expect(mockedUpdateFileStatus).not.toHaveBeenCalledWith(
      story.filePath,
      'Done',
    );
    // 残タスクのログが出ること
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('no todo tasks but story not complete'),
    );

    consoleSpy.mockRestore();
  });

  it('Todo タスクが実行されてすべて Done になればストーリーが Done に更新される', async () => {
    const story = createStory();
    const notifier = createMockNotifier();
    const todoTask = createTask('task-01', 'Todo');
    const doneTask = createTask('task-01', 'Done');

    // 1回目: タスク存在チェック（タスクあり）
    mockedGetStoryTasks.mockResolvedValueOnce([todoTask]);
    // 2回目: Todo フィルタ用
    mockedGetStoryTasks.mockResolvedValueOnce([todoTask]);
    // 3回目: 完了判定用（実行後は Done）
    mockedGetStoryTasks.mockResolvedValueOnce([doneTask]);

    await runStory(story, notifier);

    // ストーリーが Done に更新されること
    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });

  it('Done + Skipped の組み合わせでもストーリーが Done に更新される', async () => {
    const story = createStory();
    const notifier = createMockNotifier();
    const tasks = [
      createTask('task-01', 'Done'),
      createTask('task-02', 'Skipped'),
      createTask('task-03', 'Done'),
    ];

    mockedGetStoryTasks.mockResolvedValue(tasks);

    await runStory(story, notifier);

    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('一部スキップ/失敗あり'),
    );
  });

  it('Done + Failed の組み合わせでもストーリーが Done に更新される', async () => {
    const story = createStory();
    const notifier = createMockNotifier();
    const tasks = [
      createTask('task-01', 'Done'),
      createTask('task-02', 'Failed'),
    ];

    mockedGetStoryTasks.mockResolvedValue(tasks);

    await runStory(story, notifier);

    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('一部スキップ/失敗あり'),
    );
  });

  it('Done + Skipped + Failed で全タスクが終端状態ならストーリー完了', async () => {
    const story = createStory();
    const notifier = createMockNotifier();
    const tasks = [
      createTask('task-01', 'Done'),
      createTask('task-02', 'Skipped'),
      createTask('task-03', 'Failed'),
    ];

    mockedGetStoryTasks.mockResolvedValue(tasks);

    await runStory(story, notifier);

    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');
  });

  it('タスク実行中の例外が発生してもストーリー実行が継続する', async () => {
    const story = createStory();
    const notifier = createMockNotifier();
    const todoTask1 = createTask('task-01', 'Todo');
    const todoTask2 = createTask('task-02', 'Todo');

    // 1回目: タスク存在チェック
    mockedGetStoryTasks.mockResolvedValueOnce([todoTask1, todoTask2]);
    // 2回目: Todo フィルタ用
    mockedGetStoryTasks.mockResolvedValueOnce([todoTask1, todoTask2]);

    // task-01 の実行で Claude agent がエラーを投げる
    mockQuery
      .mockImplementationOnce(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('agent crash')),
        }),
      }))
      // task-02 は正常
      .mockImplementationOnce(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ done: true, value: undefined }),
        }),
      }));

    // 3回目: 完了判定用
    mockedGetStoryTasks.mockResolvedValueOnce([
      createTask('task-01', 'Failed'),
      createTask('task-02', 'Done'),
    ]);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runStory(story, notifier);

    // task-01 は Failed に更新される
    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(todoTask1.filePath, 'Failed');
    // ストーリーは完了する（全タスクが終端状態）
    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(story.filePath, 'Done');

    consoleErrorSpy.mockRestore();
  });
});

describe('runTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }));
  });

  it('開始承認で拒否されたタスクが Skipped に更新される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('reject');
    const repoPath = '/Users/test/dev/myproject';

    await runTask(task, story, notifier, repoPath);

    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(task.filePath, 'Skipped');
    expect(mockedUpdateFileStatus).not.toHaveBeenCalledWith(task.filePath, 'Doing');
  });

  it('タスク実行中に例外が発生した場合、タスクが Failed に更新される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    // Claude agent がエラーを投げる
    mockQuery.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crash')),
      }),
    }));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runTask(task, story, notifier, repoPath)).rejects.toThrow('agent crash');

    // Doing に更新された後、Failed に更新される
    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(task.filePath, 'Doing');
    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(task.filePath, 'Failed');
    // Done には更新されない
    expect(mockedUpdateFileStatus).not.toHaveBeenCalledWith(task.filePath, 'Done');

    consoleErrorSpy.mockRestore();
  });

  it('正常実行時に syncMainBranch が呼ばれてから Doing に遷移する', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    const callOrder: string[] = [];
    mockedSyncMainBranch.mockImplementation(async () => {
      callOrder.push('syncMainBranch');
    });
    mockedUpdateFileStatus.mockImplementation((_path, status) => {
      callOrder.push(`updateFileStatus:${status}`);
    });

    await runTask(task, story, notifier, repoPath);

    // syncMainBranch が repoPath で呼ばれること
    expect(mockedSyncMainBranch).toHaveBeenCalledWith(repoPath);
    // syncMainBranch → Doing → Done の順で呼ばれること
    expect(callOrder).toEqual([
      'syncMainBranch',
      'updateFileStatus:Doing',
      'updateFileStatus:Done',
    ]);
  });

  it('syncMainBranch が GitSyncError で失敗した場合、通知が送信されタスクが Failed になり Agent は実行されない', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockedSyncMainBranch.mockRejectedValueOnce(
      new GitSyncError('Failed to checkout main: error: Your local changes would be overwritten'),
    );

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // GitSyncError の場合は throw せず return する
    await runTask(task, story, notifier, repoPath);

    // 通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('main同期失敗'),
    );
    // 通知にタスクslugが含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('task-01'),
    );
    // 通知にエラー原因が含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('Failed to checkout main'),
    );
    // タスクが Failed に更新されること
    expect(mockedUpdateFileStatus).toHaveBeenCalledWith(task.filePath, 'Failed');
    // Doing には遷移しないこと
    expect(mockedUpdateFileStatus).not.toHaveBeenCalledWith(task.filePath, 'Doing');
    // Done には遷移しないこと
    expect(mockedUpdateFileStatus).not.toHaveBeenCalledWith(task.filePath, 'Done');
    // Claude Agent が実行されないこと
    expect(mockQuery).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('syncMainBranch が GitSyncError 以外のエラーで失敗した場合は throw される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockedSyncMainBranch.mockRejectedValueOnce(new Error('unexpected error'));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runTask(task, story, notifier, repoPath)).rejects.toThrow('unexpected error');

    // notify は呼ばれないこと
    expect(notifier.notify).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('buildTaskPrompt の出力にmain同期済みの旨と git pull 不要の指示が含まれる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    await runTask(task, story, notifier, repoPath);

    // mockQuery に渡されたプロンプトを検証
    expect(mockQuery).toHaveBeenCalled();
    const callArgs = mockQuery.mock.calls[0] as unknown[];
    const options = callArgs[0] as { prompt: string };
    const prompt = options.prompt;

    // mainブランチは同期済みの旨が含まれている
    expect(prompt).toContain('mainブランチは最新の状態に同期済みです');
    // git pull 不要の指示が含まれている
    expect(prompt).toContain('git pull は不要です');
    // feature ブランチを直接作成する指示が含まれている
    expect(prompt).toContain('直接 feature ブランチを作成してください');
  });

  it('タスク実行後にセルフレビューループが呼ばれる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    await runTask(task, story, notifier, repoPath);

    // runReviewLoop が呼ばれたことを確認
    expect(mockRunReviewLoop).toHaveBeenCalledWith(
      repoPath,
      'feature/task-01',
      task.content,
    );
    // レビュー結果の通知が送信されたことを確認
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('セルフレビュー結果'),
    );
  });

  it('セルフレビューでエスカレーション時、PRが作成されずエスカレーション通知が送信される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockRunReviewLoop.mockResolvedValueOnce({
      finalVerdict: 'NG',
      escalationRequired: true,
      iterations: [
        { iteration: 1, reviewResult: { verdict: 'NG', summary: 'Issues', findings: [] }, timestamp: new Date() },
      ],
      lastReviewResult: { verdict: 'NG', summary: 'Issues', findings: [] },
    });

    const consoleSpy = vi.spyOn(console, 'log');

    await runTask(task, story, notifier, repoPath);

    // PR作成のためのexecSyncが呼ばれないこと（git push, gh pr create）
    expect(mockExecSync).not.toHaveBeenCalled();

    // PR作成スキップのログが出力されること
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('self-review NG, skipping PR creation'),
    );

    // レビューエスカレーション通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('レビューエスカレーション'),
    );

    // 完了承認のメッセージにセルフレビュー未通過が含まれること
    const approvalCalls = (notifier.requestApproval as ReturnType<typeof vi.fn>).mock.calls;
    const doneApprovalCall = approvalCalls.find(
      (call: unknown[]) => (call[1] as string).includes('タスク完了確認'),
    );
    expect(doneApprovalCall).toBeDefined();
    expect(doneApprovalCall![1]).toContain('セルフレビュー未通過');

    consoleSpy.mockRestore();
  });

  it('セルフレビュー通過時、PRが作成されCIパス後にマージ承認依頼が送信される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    // git push と gh pr create が成功するようモック
    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create

    await runTask(task, story, notifier, repoPath);

    // git push が呼ばれること
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git push -u origin feature/task-01'),
      expect.any(Object),
    );
    // gh pr create が呼ばれること
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('gh pr create'),
      expect.any(Object),
    );

    // CI成功 → マージ承認依頼が送信されること
    const approvalCalls = (notifier.requestApproval as ReturnType<typeof vi.fn>).mock.calls;
    const mergeApprovalCall = approvalCalls.find(
      (call: unknown[]) => (call[1] as string).includes('マージ承認依頼'),
    );
    expect(mergeApprovalCall).toBeDefined();
  });

  it('PR作成後にCIポーリングループが実行される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create

    await runTask(task, story, notifier, repoPath);

    // CIポーリングが呼ばれたことを確認
    expect(mockRunCIPollingLoop).toHaveBeenCalledWith(
      repoPath,
      'feature/task-01',
      task.content,
    );
  });

  it('CI成功時、マージ承認依頼が送信される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    await runTask(task, story, notifier, repoPath);

    const approvalCalls = (notifier.requestApproval as ReturnType<typeof vi.fn>).mock.calls;
    const mergeApprovalCall = approvalCalls.find(
      (call: unknown[]) => (call[1] as string).includes('マージ承認依頼'),
    );
    expect(mergeApprovalCall).toBeDefined();
    // マージ承認のボタンラベルが正しいこと
    expect(mergeApprovalCall![2]).toEqual({ approve: 'マージ承認', reject: '差し戻し' });
  });

  it('CI失敗時、CIエスカレーション通知が送信され完了確認メッセージにCI未通過が含まれる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1');

    mockRunCIPollingLoop.mockResolvedValueOnce({
      finalStatus: 'max_retries_exceeded',
      attempts: 4,
      attemptResults: [
        { attempt: 1, ciResult: { status: 'failure', summary: 'fail' }, timestamp: new Date() },
      ],
      lastCIResult: { status: 'failure', summary: 'fail' },
    });

    await runTask(task, story, notifier, repoPath);

    // CIエスカレーション通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('CIエスカレーション'),
    );

    const approvalCalls = (notifier.requestApproval as ReturnType<typeof vi.fn>).mock.calls;
    const doneApprovalCall = approvalCalls.find(
      (call: unknown[]) => (call[1] as string).includes('タスク完了確認'),
    );
    expect(doneApprovalCall).toBeDefined();
    expect(doneApprovalCall![1]).toContain('CI未通過');
  });

  it('セルフレビューNG時はCIポーリングが呼ばれない', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockRunReviewLoop.mockResolvedValueOnce({
      finalVerdict: 'NG',
      escalationRequired: true,
      iterations: [
        { iteration: 1, reviewResult: { verdict: 'NG', summary: 'Issues', findings: [] }, timestamp: new Date() },
      ],
      lastReviewResult: { verdict: 'NG', summary: 'Issues', findings: [] },
    });

    const consoleSpy = vi.spyOn(console, 'log');

    await runTask(task, story, notifier, repoPath);

    // CIポーリングが呼ばれないこと
    expect(mockRunCIPollingLoop).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('PR作成失敗時（prUrl空）はCIポーリングが呼ばれない', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // PR作成が完全に失敗するケース
    mockExecSync.mockImplementation(() => {
      throw new Error('push failed');
    });

    await runTask(task, story, notifier, repoPath);

    expect(mockRunCIPollingLoop).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('buildTaskPrompt の出力にPR自動作成の旨と gh pr create 不要の指示が含まれる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    await runTask(task, story, notifier, repoPath);

    expect(mockQuery).toHaveBeenCalled();
    const callArgs = mockQuery.mock.calls[0] as unknown[];
    const options = callArgs[0] as { prompt: string };
    const prompt = options.prompt;

    // PR自動作成の旨が含まれている
    expect(prompt).toContain('PRの作成は自動で行われる');
    // gh pr create 不要の指示が含まれている
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('実行しないこと');
  });

  it('正常実行時は Doing → Done の順で更新される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    await runTask(task, story, notifier, repoPath);

    const calls = mockedUpdateFileStatus.mock.calls;
    expect(calls).toEqual([
      [task.filePath, 'Doing'],
      [task.filePath, 'Done'],
    ]);
  });
});

describe('formatReviewSummaryForPR', () => {
  it('OK判定の場合にセルフレビュー通過のMarkdownが生成される', () => {
    const result = formatReviewSummaryForPR({
      finalVerdict: 'OK',
      escalationRequired: false,
      iterations: [
        {
          iteration: 1,
          reviewResult: { verdict: 'OK', summary: 'All good', findings: [] },
          timestamp: new Date(),
        },
      ],
      lastReviewResult: { verdict: 'OK', summary: 'All good', findings: [] },
    });

    expect(result).toContain('## セルフレビュー結果');
    expect(result).toContain('✅ **セルフレビュー通過**');
    expect(result).toContain('イテレーション数: 1');
    expect(result).toContain('最終判定: OK');
    expect(result).toContain('要約: All good');
  });

  it('NG判定の場合にセルフレビュー未通過のMarkdownが生成される', () => {
    const result = formatReviewSummaryForPR({
      finalVerdict: 'NG',
      escalationRequired: true,
      iterations: [
        {
          iteration: 1,
          reviewResult: {
            verdict: 'NG',
            summary: 'Issues found',
            findings: [
              { severity: 'error', message: 'Missing error handling', file: 'src/index.ts', line: 10 },
            ],
          },
          timestamp: new Date(),
        },
      ],
      lastReviewResult: {
        verdict: 'NG',
        summary: 'Issues found',
        findings: [
          { severity: 'error', message: 'Missing error handling', file: 'src/index.ts', line: 10 },
        ],
      },
    });

    expect(result).toContain('⚠️ **セルフレビュー未通過**');
    expect(result).toContain('最終レビュー指摘事項');
    expect(result).toContain('[ERROR]');
    expect(result).toContain('Missing error handling');
    expect(result).toContain('`src/index.ts:10`');
  });

  it('複数イテレーションの場合に修正履歴が含まれる', () => {
    const result = formatReviewSummaryForPR({
      finalVerdict: 'OK',
      escalationRequired: false,
      iterations: [
        {
          iteration: 1,
          reviewResult: {
            verdict: 'NG',
            summary: 'Issues found',
            findings: [{ severity: 'error', message: 'Bug found' }],
          },
          fixDescription: 'Fixed the bug',
          timestamp: new Date(),
        },
        {
          iteration: 2,
          reviewResult: { verdict: 'OK', summary: 'All fixed', findings: [] },
          timestamp: new Date(),
        },
      ],
      lastReviewResult: { verdict: 'OK', summary: 'All fixed', findings: [] },
    });

    expect(result).toContain('### 修正履歴');
    expect(result).toContain('**イテレーション 1**: ❌ NG');
    expect(result).toContain('**イテレーション 2**: ✅ OK');
    expect(result).toContain('修正実施済み');
    expect(result).toContain('イテレーション数: 2');
  });
});

describe('createPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正常時にgit pushとgh pr createが実行されPR URLが返される', () => {
    const task = createTask('task-01', 'Todo');
    const story = createStory();
    const reviewResult = {
      finalVerdict: 'OK' as const,
      escalationRequired: false,
      iterations: [
        {
          iteration: 1,
          reviewResult: { verdict: 'OK' as const, summary: 'All good', findings: [] },
          timestamp: new Date(),
        },
      ],
      lastReviewResult: { verdict: 'OK' as const, summary: 'All good', findings: [] },
    };

    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create

    const url = createPullRequest('/repo', 'feature/task-01', task, story, reviewResult);

    expect(url).toBe('https://github.com/test/repo/pull/1');
    expect(mockExecSync).toHaveBeenCalledTimes(2);

    // git push の呼び出し確認
    expect(mockExecSync).toHaveBeenCalledWith(
      'git push -u origin feature/task-01',
      expect.objectContaining({ cwd: '/repo' }),
    );

    // gh pr create の呼び出し確認（PR本文にレビューサマリーが含まれる）
    const prCreateCall = mockExecSync.mock.calls[1];
    const prCreateCmd = prCreateCall[0] as string;
    expect(prCreateCmd).toContain('gh pr create');
    expect(prCreateCmd).toContain('--base main');
    expect(prCreateCmd).toContain('--head feature/task-01');
    expect(prCreateCmd).toContain('セルフレビュー結果');
  });

  it('PR作成が失敗した場合に既存PRのURL取得を試みる', () => {
    const task = createTask('task-01', 'Todo');
    const story = createStory();
    const reviewResult = {
      finalVerdict: 'OK' as const,
      escalationRequired: false,
      iterations: [
        {
          iteration: 1,
          reviewResult: { verdict: 'OK' as const, summary: 'All good', findings: [] },
          timestamp: new Date(),
        },
      ],
      lastReviewResult: { verdict: 'OK' as const, summary: 'All good', findings: [] },
    };

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockImplementationOnce(() => { throw new Error('PR already exists'); }) // gh pr create
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr view fallback

    const url = createPullRequest('/repo', 'feature/task-01', task, story, reviewResult);

    expect(url).toBe('https://github.com/test/repo/pull/1');
    expect(mockExecSync).toHaveBeenCalledTimes(3);

    consoleErrorSpy.mockRestore();
  });

  it('PR作成もURL取得も失敗した場合に空文字が返される', () => {
    const task = createTask('task-01', 'Todo');
    const story = createStory();
    const reviewResult = {
      finalVerdict: 'OK' as const,
      escalationRequired: false,
      iterations: [
        {
          iteration: 1,
          reviewResult: { verdict: 'OK' as const, summary: 'All good', findings: [] },
          timestamp: new Date(),
        },
      ],
      lastReviewResult: { verdict: 'OK' as const, summary: 'All good', findings: [] },
    };

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockExecSync
      .mockImplementationOnce(() => { throw new Error('push failed'); }); // git push fails

    const url = createPullRequest('/repo', 'feature/task-01', task, story, reviewResult);

    expect(url).toBe('');

    consoleErrorSpy.mockRestore();
  });
});
