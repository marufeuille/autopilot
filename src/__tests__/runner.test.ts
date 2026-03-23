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
  recordTaskCompletion: vi.fn(),
}));

vi.mock('../decomposer', () => ({
  decomposeTasks: vi.fn(),
}));

vi.mock('../notification', () => ({
  generateApprovalId: vi.fn(
    (story: string, task: string) => `${story}--${task}--1`,
  ),
  buildMergeApprovalMessage: vi.fn((ctx: any) => `マージ実行依頼: ${ctx.taskSlug}`),
  buildMergeCompletedMessage: vi.fn((taskSlug: string, prUrl: string) => `✅ *マージ完了*\n*タスク*: \`${taskSlug}\`\n*PR*: ${prUrl}\n*ステータス*: \`merged\``),
  buildMergeBlockedMessage: vi.fn((taskSlug: string, prUrl: string) => `🚫 *マージ不可*\n*タスク*: \`${taskSlug}\`\n*PR*: ${prUrl}`),
  buildReviewEscalationMessage: vi.fn((ctx: any) => `レビューエスカレーション: ${ctx.taskSlug}`),
  buildCIEscalationMessage: vi.fn((ctx: any) => `CIエスカレーション: ${ctx.taskSlug}`),
  buildThreadOriginMessage: vi.fn((slug: string) => `スレッド起点: ${slug}`),
}));

vi.mock('../git', () => ({
  syncMainBranch: vi.fn().mockResolvedValue(undefined),
  detectNoRemote: vi.fn().mockReturnValue(false),
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

// マージモジュールをモック
const mockExecuteMerge = vi.fn().mockReturnValue({ success: true, prUrl: '', output: undefined });
const mockFormatMergeErrorMessage = vi.fn((error: any) => `❌ ${error.reason}`);
const mockFetchPullRequestStatus = vi.fn().mockReturnValue({
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  reviewDecision: 'APPROVED',
  statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
});
const mockValidateMergeConditions = vi.fn().mockReturnValue({
  mergeable: true,
  errors: [],
});
vi.mock('../merge', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    executeMerge: (...args: unknown[]) => mockExecuteMerge(...args),
    formatMergeErrorMessage: (...args: unknown[]) => mockFormatMergeErrorMessage(...args),
    fetchPullRequestStatus: (...args: unknown[]) => mockFetchPullRequestStatus(...args),
    validateMergeConditions: (...args: unknown[]) => mockValidateMergeConditions(...args),
  };
});

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

// child_process の execSync / execFileSync をモック（PR作成・URL取得・マージで使われる）
const mockExecSync = vi.fn(() => '');
const mockExecFileSync = vi.fn(() => '');
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// fs の writeFileSync / unlinkSync をモック（PR body一時ファイルで使われる）
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock('fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
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
import { updateFileStatus, recordTaskCompletion } from '../vault/writer';
import { decomposeTasks } from '../decomposer';
import { syncMainBranch, GitSyncError } from '../git';
import { MergeError } from '../merge';
import { runStory, runTask, formatReviewSummaryForPR, createPullRequest } from '../runner';

const mockedGetStoryTasks = vi.mocked(getStoryTasks);
const mockedUpdateFileStatus = vi.mocked(updateFileStatus);
const mockedRecordTaskCompletion = vi.mocked(recordTaskCompletion);
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
    startThread: vi.fn().mockResolvedValue(undefined),
    getThreadTs: vi.fn().mockReturnValue(undefined),
    endSession: vi.fn(),
  };
}

describe('runStory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }));
    // デフォルト: git push は空文字、gh pr create はダミーURLを返す（infinite loopを防ぐ）
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('gh pr create')) {
        return 'https://github.com/test/repo/pull/1';
      }
      return '';
    });
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
      'my-story',
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
      'my-story',
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
      'my-story',
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
    // デフォルト: git push は空文字、gh pr create はダミーURLを返す（infinite loopを防ぐ）
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('gh pr create')) {
        return 'https://github.com/test/repo/pull/1';
      }
      return '';
    });
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
    mockedRecordTaskCompletion.mockImplementation(() => {
      callOrder.push('recordTaskCompletion');
    });

    await runTask(task, story, notifier, repoPath);

    // syncMainBranch が repoPath で呼ばれること
    expect(mockedSyncMainBranch).toHaveBeenCalledWith(repoPath);
    // syncMainBranch → Doing → recordTaskCompletion の順で呼ばれること
    expect(callOrder).toEqual([
      'syncMainBranch',
      'updateFileStatus:Doing',
      'recordTaskCompletion',
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
      'my-story',
    );
    // 通知にタスクslugが含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('task-01'),
      'my-story',
    );
    // 通知にエラー原因が含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('Failed to checkout main'),
      'my-story',
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
      'my-story',
    );
  });

  it('セルフレビューでエスカレーション時、エスカレーション通知が送信されてretryされる', async () => {
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

    await runTask(task, story, notifier, repoPath);

    // レビューエスカレーション通知が送信されること（新パイプラインのメッセージ形式）
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('セルフレビュー未通過（エスカレーション）'),
      'my-story',
    );
  });

  it('セルフレビュー通過時、PRが作成されCIパス後にマージ実行依頼が送信される', async () => {
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

    // CI成功 → マージ実行依頼が送信されること
    const approvalCalls = (notifier.requestApproval as ReturnType<typeof vi.fn>).mock.calls;
    const mergeApprovalCall = approvalCalls.find(
      (call: unknown[]) => (call[1] as string).includes('マージ実行依頼'),
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

  it('CI成功時、マージ実行依頼が送信される', async () => {
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
      (call: unknown[]) => (call[1] as string).includes('マージ実行依頼'),
    );
    expect(mergeApprovalCall).toBeDefined();
    // マージ実行のボタンラベルが正しいこと
    expect(mergeApprovalCall![2]).toEqual({ approve: 'マージ実行', reject: '差し戻し' });
  });

  it('マージ実行後に executeMerge が実行されPRがマージされる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create
    mockExecuteMerge.mockReturnValueOnce({ success: true, prUrl: 'https://github.com/test/repo/pull/1', output: undefined });

    await runTask(task, story, notifier, repoPath);

    // executeMerge が呼ばれること
    expect(mockExecuteMerge).toHaveBeenCalledWith(
      'https://github.com/test/repo/pull/1',
      repoPath,
      expect.any(Object),
      { skipValidation: false },
    );

    // タスク完了が Vault に記録されること
    expect(mockedRecordTaskCompletion).toHaveBeenCalled();

    // マージ成功通知がユーザーに送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ完了'),
      'my-story',
    );
  });

  it('マージ成功時にマージ完了通知がPR URLとタスクslugを含む', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create
    mockExecuteMerge.mockReturnValueOnce({ success: true, prUrl: 'https://github.com/test/repo/pull/1', output: undefined });

    await runTask(task, story, notifier, repoPath);

    // マージ完了通知にPR URLとタスクslugが含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringMatching(/マージ完了.*task-01/s),
      'my-story',
    );
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/test/repo/pull/1'),
      'my-story',
    );
  });

  it('マージ失敗時に構造化されたMergeErrorが適切にハンドリングされる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    const mergeError = new MergeError('merge_conflict', 'マージコンフリクトが発生しています: merge conflict', 409);
    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create
    mockExecuteMerge.mockImplementationOnce(() => { throw mergeError; });

    // マージ失敗後はpr-lifecycleからretryされ、2回目のマージで成功してDoneになる
    await runTask(task, story, notifier, repoPath);

    // マージ失敗通知がユーザーに送信されること（構造化エラー情報を含む）
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ失敗'),
      'my-story',
    );
    // エラーコードが通知に含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('merge_conflict'),
      'my-story',
    );
    // マージ処理中通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ処理中'),
      'my-story',
    );

    // マージ失敗後はpr-lifecycleからretryされ、最終的にrecordTaskCompletionが呼ばれること
    expect(mockedRecordTaskCompletion).toHaveBeenCalled();
  });

  it('CI失敗時、CI未通過通知が送信されimplementationからretryされる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockExecSync
      .mockReturnValueOnce('') // git push (1回目)
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create (1回目)

    mockRunCIPollingLoop.mockResolvedValueOnce({
      finalStatus: 'max_retries_exceeded',
      attempts: 4,
      attemptResults: [
        { attempt: 1, ciResult: { status: 'failure', summary: 'fail' }, timestamp: new Date() },
      ],
      lastCIResult: { status: 'failure', summary: 'fail' },
    });

    await runTask(task, story, notifier, repoPath);

    // CI未通過通知が送信されること（新パイプラインのメッセージ形式）
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('CI未通過'),
      'my-story',
    );
  });

  it('セルフレビューNG時はretryされエスカレーション通知が送信される', async () => {
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

    await runTask(task, story, notifier, repoPath);

    // エスカレーション通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('セルフレビュー未通過（エスカレーション）'),
      'my-story',
    );
  });

  it('PR作成失敗時（prUrl空）はPR作成失敗通知が送信される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    // 1回目のPR作成が失敗するケース（git push + gh pr view も失敗）
    mockExecSync
      .mockImplementationOnce(() => { throw new Error('push failed'); }) // git push
      .mockImplementationOnce(() => { throw new Error('view failed'); }); // gh pr view fallback

    await runTask(task, story, notifier, repoPath);

    // PR作成失敗通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('PR作成失敗'),
      'my-story',
    );
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

  it('正常実行時は Doing で updateFileStatus が呼ばれ、完了時は recordTaskCompletion が呼ばれる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    await runTask(task, story, notifier, repoPath);

    // updateFileStatus は Doing のみ（Done は recordTaskCompletion に移行）
    const calls = mockedUpdateFileStatus.mock.calls;
    expect(calls).toEqual([
      [task.filePath, 'Doing'],
    ]);
    // recordTaskCompletion が呼ばれること
    expect(mockedRecordTaskCompletion).toHaveBeenCalled();
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

describe('runTask - マージ後ステータス更新フロー', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    }));
    // デフォルト: git push は空文字、gh pr create はダミーURLを返す（infinite loopを防ぐ）
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('gh pr create')) {
        return 'https://github.com/test/repo/pull/1';
      }
      return '';
    });
  });

  /**
   * ヘルパー: マージ実行フローに到達するための標準モック設定
   * レビューOK → PR作成成功 → CI成功 → マージ実行 の前提条件を設定する
   */
  function setupMergeFlowMocks(
    notifier: NotificationBackend,
    options?: {
      mergeImpl?: () => { success: boolean; prUrl: string; output?: string };
    },
  ) {
    // git push + gh pr create
    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/42'); // gh pr create

    // executeMerge
    if (options?.mergeImpl) {
      mockExecuteMerge.mockImplementationOnce(options.mergeImpl);
    } else {
      mockExecuteMerge.mockReturnValueOnce({ success: true, prUrl: 'https://github.com/test/repo/pull/42', output: undefined });
    }

    // requestApproval を順番に設定: 開始承認→マージ実行
    (notifier.requestApproval as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ action: 'approve' })  // タスク開始承認
      .mockResolvedValueOnce({ action: 'approve' }); // マージ実行
  }

  it('executeMerge 成功後に updateFileStatus(Done) が呼ばれ、呼び出し順序が正しい', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    // git push + gh pr create
    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/42'); // gh pr create

    // requestApproval: 開始承認→マージ実行
    (notifier.requestApproval as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ action: 'approve' })  // タスク開始承認
      .mockResolvedValueOnce({ action: 'approve' }); // マージ実行

    const callOrder: string[] = [];
    mockedUpdateFileStatus.mockImplementation((_path, status) => {
      callOrder.push(`updateFileStatus:${status}`);
    });
    mockedRecordTaskCompletion.mockImplementation(() => {
      callOrder.push('recordTaskCompletion');
    });
    mockExecuteMerge.mockImplementationOnce(() => {
      callOrder.push('executeMerge');
      return { success: true, prUrl: 'https://github.com/test/repo/pull/42', output: undefined };
    });

    await runTask(task, story, notifier, repoPath);

    // Doing → executeMerge → recordTaskCompletion の順序で呼ばれること
    expect(callOrder).toEqual([
      'updateFileStatus:Doing',
      'executeMerge',
      'recordTaskCompletion',
    ]);
  });

  it('executeMerge 失敗時にエラー通知が送信され、pr-lifecycleからretryされDoneになる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    setupMergeFlowMocks(notifier, {
      mergeImpl: () => { throw new MergeError('merge_conflict', 'マージコンフリクト', 409); },
    });

    // マージ失敗後はpr-lifecycleからretryされ、3回目の承認（2回目のマージ実行）で成功
    (notifier.requestApproval as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ action: 'approve' }); // 2回目のマージ実行承認

    // マージ失敗時はthrowせず、pr-lifecycleからretryされる
    await runTask(task, story, notifier, repoPath);

    // エラー通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ失敗'),
      story.slug,
    );
    // エラーコードが通知に含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('merge_conflict'),
      story.slug,
    );

    // pr-lifecycleからretryされ最終的にrecordTaskCompletionが呼ばれること
    expect(mockedRecordTaskCompletion).toHaveBeenCalled();
  });

  it('executeMerge 失敗時にマージ処理中通知とエラー通知が順番に送信される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    setupMergeFlowMocks(notifier, {
      mergeImpl: () => { throw new MergeError('unknown', 'API error', 500); },
    });

    // マージ失敗後はpr-lifecycleからretryされ、3回目の承認（2回目のマージ実行）で成功
    (notifier.requestApproval as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ action: 'approve' }); // 2回目のマージ実行承認

    await runTask(task, story, notifier, repoPath);

    // マージ処理中通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ処理中'),
      story.slug,
    );
    // エラー通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ失敗'),
      story.slug,
    );

    const notifyCalls = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls;
    const mergeInProgressIdx = notifyCalls.findIndex(
      (call: unknown[]) => (call[0] as string).includes('マージ処理中'),
    );
    const mergeFailedIdx = notifyCalls.findIndex(
      (call: unknown[]) => (call[0] as string).includes('マージ失敗'),
    );
    // マージ処理中 → マージ失敗 の順序
    expect(mergeInProgressIdx).toBeLessThan(mergeFailedIdx);
  });

  it('マージ実行で差し戻された場合、executeMerge は呼ばれず再実行ループに入る', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier: NotificationBackend = {
      notify: vi.fn().mockResolvedValue(undefined),
      requestApproval: vi.fn()
        .mockResolvedValueOnce({ action: 'approve' })  // タスク開始承認
        .mockResolvedValueOnce({ action: 'reject', reason: '要修正' })  // マージ差し戻し
        .mockResolvedValueOnce({ action: 'approve' })   // 2回目マージ実行
      ,
      startThread: vi.fn().mockResolvedValue(undefined),
      getThreadTs: vi.fn().mockReturnValue(undefined),
      endSession: vi.fn(),
    };
    const repoPath = '/Users/test/dev/myproject';

    // 1回目のPR作成
    mockExecSync
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/42') // gh pr create
      // 2回目のPR作成
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/42'); // gh pr create (already exists fallback)

    // 2回目のマージ
    mockExecuteMerge.mockReturnValueOnce({ success: true, prUrl: 'https://github.com/test/repo/pull/42', output: undefined });

    await runTask(task, story, notifier, repoPath);

    // 差し戻し時にはexecuteMergeが呼ばれず、2回目の承認で呼ばれること
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1);
    expect(mockExecuteMerge).toHaveBeenCalledWith(
      'https://github.com/test/repo/pull/42',
      repoPath,
      expect.any(Object),
      { skipValidation: false },
    );

    // 最終的にrecordTaskCompletionが呼ばれること
    expect(mockedRecordTaskCompletion).toHaveBeenCalled();
  });

  it('マージ成功時にマージ処理中通知とマージ完了通知が順番に送信される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    setupMergeFlowMocks(notifier);

    await runTask(task, story, notifier, repoPath);

    const notifyCalls = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls;

    // マージ処理中通知が送信されること
    const mergeInProgressCall = notifyCalls.find(
      (call: unknown[]) => (call[0] as string).includes('マージ処理中'),
    );
    expect(mergeInProgressCall).toBeDefined();

    // マージ完了通知が送信されること
    const mergeCompleteCall = notifyCalls.find(
      (call: unknown[]) => (call[0] as string).includes('マージ完了'),
    );
    expect(mergeCompleteCall).toBeDefined();

    // マージ完了通知にステータス更新情報が含まれること
    expect(mergeCompleteCall![0]).toContain('merged');

    // マージ処理中 → マージ完了 の順序
    const inProgressIdx = notifyCalls.indexOf(mergeInProgressCall!);
    const completeIdx = notifyCalls.indexOf(mergeCompleteCall!);
    expect(inProgressIdx).toBeLessThan(completeIdx);
  });

  it('マージ失敗後にマージ承認でrejectするとimplementationからやり直しループに入る', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier: NotificationBackend = {
      notify: vi.fn().mockResolvedValue(undefined),
      requestApproval: vi.fn()
        .mockResolvedValueOnce({ action: 'approve' })                             // タスク開始承認
        .mockResolvedValueOnce({ action: 'approve' })                             // マージ実行（1回目）→ 失敗
        .mockResolvedValueOnce({ action: 'reject', reason: 'コンフリクト解消して' }) // 2回目マージ承認（pr-lifecycleからretry）→ reject → implementationへ
        .mockResolvedValueOnce({ action: 'approve' })                             // 3回目マージ実行 → 成功
      ,
      startThread: vi.fn().mockResolvedValue(undefined),
      getThreadTs: vi.fn().mockReturnValue(undefined),
      endSession: vi.fn(),
    };
    const repoPath = '/Users/test/dev/myproject';

    // 3回のPR作成（pr-lifecycle が3回実行される）
    mockExecSync
      .mockReturnValueOnce('') // git push (pr-lifecycle 1)
      .mockReturnValueOnce('https://github.com/test/repo/pull/42') // gh pr create (pr-lifecycle 1)
      .mockReturnValueOnce('') // git push (pr-lifecycle 2: retryFromPrLifecycle)
      .mockReturnValueOnce('https://github.com/test/repo/pull/42') // gh pr create (pr-lifecycle 2)
      .mockReturnValueOnce('') // git push (pr-lifecycle 3: retryFromImplementation)
      .mockReturnValueOnce('https://github.com/test/repo/pull/42'); // gh pr create (pr-lifecycle 3)

    // 1回目のマージ: 失敗（→ retry from pr-lifecycle）
    // 2回目のマージ承認: reject（→ retry from implementation）
    // 3回目のマージ: 成功
    mockExecuteMerge
      .mockImplementationOnce(() => { throw new MergeError('merge_conflict', 'コンフリクト', 409); })
      .mockReturnValueOnce({ success: true, prUrl: 'https://github.com/test/repo/pull/42', output: undefined });

    await runTask(task, story, notifier, repoPath);

    // executeMerge が2回呼ばれること（1回目失敗、3回目成功）
    expect(mockExecuteMerge).toHaveBeenCalledTimes(2);

    // マージ失敗通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ失敗'),
      story.slug,
    );

    // マージ成功通知も送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('マージ完了'),
      story.slug,
    );

    // 最終的にrecordTaskCompletionが呼ばれること
    expect(mockedRecordTaskCompletion).toHaveBeenCalled();
  });

  it('権限不足(403)でマージ失敗時に適切なエラーメッセージが通知される', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    setupMergeFlowMocks(notifier, {
      mergeImpl: () => { throw new MergeError('permission_denied', 'マージ権限がありません', 403); },
    });

    // マージ失敗後はpr-lifecycleからretryされ、3回目の承認（2回目のマージ実行）で成功
    (notifier.requestApproval as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ action: 'approve' }); // 2回目のマージ実行承認

    await runTask(task, story, notifier, repoPath);

    // 権限不足のエラーコードが通知に含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('permission_denied'),
      story.slug,
    );
  });

  it('マージ成功時に二重実行されないこと（break でループを抜ける）', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    setupMergeFlowMocks(notifier);

    await runTask(task, story, notifier, repoPath);

    // executeMerge が1回だけ呼ばれること
    expect(mockExecuteMerge).toHaveBeenCalledTimes(1);

    // runAgent も1回だけ呼ばれること（ループが回らない）
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('CI失敗時にCI未通過通知が送信され、implementationからretryされる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    mockExecSync
      .mockReturnValueOnce('') // git push (1回目)
      .mockReturnValueOnce('https://github.com/test/repo/pull/42'); // gh pr create (1回目)

    // CI失敗（1回目のみ）
    mockRunCIPollingLoop.mockResolvedValueOnce({
      finalStatus: 'failure',
      attempts: 1,
      attemptResults: [
        { attempt: 1, ciResult: { status: 'failure', summary: 'Tests failed' }, timestamp: new Date() },
      ],
      lastCIResult: { status: 'failure', summary: 'Tests failed' },
    });

    await runTask(task, story, notifier, repoPath);

    // CI未通過通知が送信されること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('CI未通過'),
      story.slug,
    );

    // retryされ最終的にrecordTaskCompletionが呼ばれること
    expect(mockedRecordTaskCompletion).toHaveBeenCalled();
  });

  it('マージ完了通知にmergedステータスが含まれる', async () => {
    const story = createStory();
    const task = createTask('task-01', 'Todo');
    const notifier = createMockNotifier('approve');
    const repoPath = '/Users/test/dev/myproject';

    setupMergeFlowMocks(notifier);

    await runTask(task, story, notifier, repoPath);

    // マージ完了通知にmergedステータスが含まれること
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.stringContaining('merged'),
      story.slug,
    );
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

    // gh pr create の呼び出し確認（--body-file で一時ファイル経由）
    const prCreateCall = mockExecSync.mock.calls[1];
    const prCreateCmd = prCreateCall[0] as string;
    expect(prCreateCmd).toContain('gh pr create');
    expect(prCreateCmd).toContain('--base main');
    expect(prCreateCmd).toContain('--head feature/task-01');
    expect(prCreateCmd).toContain('--body-file');
    expect(prCreateCmd).not.toContain('--body ');

    // 一時ファイルにbodyが書き出されていることを確認
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writtenBody = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenBody).toContain('セルフレビュー結果');

    // 一時ファイルが削除されていることを確認
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
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
