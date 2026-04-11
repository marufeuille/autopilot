import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskFile, TaskStatus } from '../../../vault/reader';

// モック設定
vi.mock('glob', () => ({
  glob: vi.fn(),
}));

vi.mock('../../../vault/reader', () => ({
  getStoryTasks: vi.fn(),
}));

vi.mock('../../../vault/writer', () => ({
  updateFileStatus: vi.fn(),
}));

vi.mock('../../../config', () => ({
  config: { watchProject: 'test-project', watchProjects: ['test-project'], vaultPath: '/vault' },
  vaultProjectPath: vi.fn((project: string) => `/vault/Projects/${project}`),
  vaultStoriesPath: vi.fn((project: string) => `/vault/Projects/${project}/stories`),
}));

import { glob } from 'glob';
import { getStoryTasks } from '../../../vault/reader';
import { updateFileStatus } from '../../../vault/writer';
import { config } from '../../../config';
import { handleRetry, findTaskBySlug } from '../retry';

const mockGlob = vi.mocked(glob);
const mockGetStoryTasks = vi.mocked(getStoryTasks);
const mockUpdateFileStatus = vi.mocked(updateFileStatus);

function makeTask(
  storySlug: string,
  slug: string,
  status: TaskStatus,
): TaskFile {
  return {
    filePath: `/vault/Projects/test-project/tasks/${storySlug}/${slug}.md`,
    project: 'test-project',
    storySlug,
    slug,
    status,
    frontmatter: { status },
    content: '',
  };
}

describe('findTaskBySlug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('指定スラッグのタスクを見つけて返す', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-setup', 'Failed'),
      makeTask('my-story', 'my-story-02-impl', 'Todo'),
    ]);

    const result = await findTaskBySlug('test-project', 'my-story-01-setup');

    expect(result).toBeDefined();
    expect(result!.slug).toBe('my-story-01-setup');
    expect(result!.status).toBe('Failed');
  });

  it('存在しないスラッグの場合はundefinedを返す', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-setup', 'Done'),
    ]);

    const result = await findTaskBySlug('test-project', 'nonexistent-task');

    expect(result).toBeUndefined();
  });

  it('複数ストーリーを横断して検索する', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/story-a',
      '/vault/Projects/test-project/tasks/story-b',
    ] as never);
    mockGetStoryTasks
      .mockResolvedValueOnce([makeTask('story-a', 'story-a-01', 'Done')])
      .mockResolvedValueOnce([makeTask('story-b', 'story-b-01', 'Failed')]);

    const result = await findTaskBySlug('test-project', 'story-b-01');

    expect(result).toBeDefined();
    expect(result!.slug).toBe('story-b-01');
    expect(result!.storySlug).toBe('story-b');
  });
});

describe('handleRetry', () => {
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    respond = vi.fn().mockResolvedValue(undefined);
  });

  it('タスクスラッグが指定されていない場合、使い方メッセージを返す', async () => {
    await handleRetry([], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('タスクスラッグを指定してください');
    expect(msg).toContain('/ap retry');
  });

  it('タスクが見つからない場合、エラーメッセージを返す', async () => {
    mockGlob.mockResolvedValue([] as never);

    await handleRetry(['nonexistent-task'], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('見つかりませんでした');
    expect(msg).toContain('nonexistent-task');
  });

  it('Failed以外のステータスの場合、エラーメッセージを返す', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-task', 'Doing'),
    ]);

    await handleRetry(['my-story-01-task'], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('Doing');
    expect(msg).toContain('Failed');
    expect(msg).toContain('のみ再実行できます');
    expect(mockUpdateFileStatus).not.toHaveBeenCalled();
  });

  it('Done状態のタスクに対してもエラーメッセージを返す', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-task', 'Done'),
    ]);

    await handleRetry(['my-story-01-task'], respond);

    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('Done');
    expect(msg).toContain('Failed');
    expect(mockUpdateFileStatus).not.toHaveBeenCalled();
  });

  it('Todo状態のタスクに対してもエラーメッセージを返す', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-task', 'Todo'),
    ]);

    await handleRetry(['my-story-01-task'], respond);

    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('Todo');
    expect(mockUpdateFileStatus).not.toHaveBeenCalled();
  });

  it('Failedタスクのステータスを正常にTodoに更新する', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-task', 'Failed'),
    ]);
    mockUpdateFileStatus.mockResolvedValue(undefined as never);

    await handleRetry(['my-story-01-task'], respond);

    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      '/vault/Projects/test-project/tasks/my-story/my-story-01-task.md',
      'Todo',
    );
    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      '/vault/Projects/test-project/stories/my-story.md',
      'Doing',
    );
    expect(mockUpdateFileStatus).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('Todo');
    expect(msg).toContain('my-story-01-task');
    expect(msg).toContain('再実行をトリガーしました');
    expect(msg).toContain('my-story');
  });

  it('ストーリーファイル更新失敗時にタスクステータスをロールバックする', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-task', 'Failed'),
    ]);
    // 1回目(タスク→Todo)は成功、2回目(ストーリー→Doing)は失敗、3回目(タスク→Failedロールバック)は成功
    mockUpdateFileStatus
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('story file not found'))
      .mockResolvedValueOnce(undefined as never);

    await handleRetry(['my-story-01-task'], respond);

    // ロールバックが呼ばれていること
    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      '/vault/Projects/test-project/tasks/my-story/my-story-01-task.md',
      'Failed',
    );
    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('エラー');
    expect(msg).toContain('story file not found');
  });

  it('updateFileStatusが失敗した場合、エラーメッセージを返す', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/tasks/my-story',
    ] as never);
    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'my-story-01-task', 'Failed'),
    ]);
    mockUpdateFileStatus.mockRejectedValue(new Error('write permission denied'));

    await handleRetry(['my-story-01-task'], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('エラー');
    expect(msg).toContain('write permission denied');
  });

  it('処理中にエラーが発生した場合、エラーメッセージを返す', async () => {
    mockGlob.mockRejectedValue(new Error('disk read error'));

    await handleRetry(['some-task'], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('エラー');
    expect(msg).toContain('disk read error');
  });
});

describe('handleRetry - multi-project', () => {
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    respond = vi.fn().mockResolvedValue(undefined);
    // watchProjects を複数プロジェクトに設定
    (config as any).watchProjects = ['project-a', 'project-b'];
  });

  afterEach(() => {
    // 元に戻す
    (config as any).watchProjects = ['test-project'];
  });

  it('複数プロジェクトを横断してタスクを検索する', async () => {
    // project-a にはタスクなし
    mockGlob
      .mockResolvedValueOnce([] as never)  // project-a の tasks ディレクトリ
      .mockResolvedValueOnce([             // project-b の tasks ディレクトリ
        '/vault/Projects/project-b/tasks/my-story',
      ] as never);

    mockGetStoryTasks
      .mockResolvedValueOnce([
        makeTask('my-story', 'target-task', 'Failed'),
      ]);

    mockUpdateFileStatus.mockResolvedValue(undefined as never);

    await handleRetry(['target-task'], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('target-task');
    expect(msg).toContain('再実行をトリガーしました');
  });
});
