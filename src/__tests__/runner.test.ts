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

// Claude agent SDK をモック（runTask 内で使われる）
const mockQuery = vi.fn(() => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// child_process の execSync をモック（PR URL 取得で使われる）
vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { getStoryTasks } from '../vault/reader';
import { updateFileStatus } from '../vault/writer';
import { decomposeTasks } from '../decomposer';
import { syncMainBranch, GitSyncError } from '../git';
import { runStory, runTask } from '../runner';

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
