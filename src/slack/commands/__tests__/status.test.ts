import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoryFile, TaskFile, TaskStatus } from '../../../vault/reader';

// モック設定
vi.mock('glob', () => ({
  glob: vi.fn(),
}));

vi.mock('../../../vault/reader', () => ({
  readStoryFile: vi.fn(),
  getStoryTasks: vi.fn(),
}));

vi.mock('../../../config', () => ({
  config: { watchProject: 'test-project', watchProjects: ['test-project'], vaultPath: '/vault' },
  vaultStoriesPath: vi.fn(() => '/vault/Projects/test-project/stories'),
}));

import { glob } from 'glob';
import { readStoryFile, getStoryTasks } from '../../../vault/reader';
import { handleStatus, summarizeTaskStatuses, formatStatusSummary } from '../status';

const mockGlob = vi.mocked(glob);
const mockReadStoryFile = vi.mocked(readStoryFile);
const mockGetStoryTasks = vi.mocked(getStoryTasks);

function makeStory(slug: string, status: string): StoryFile {
  return {
    filePath: `/vault/Projects/test-project/stories/${slug}.md`,
    project: 'test-project',
    slug,
    status,
    frontmatter: { status },
    content: '',
  };
}

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

describe('summarizeTaskStatuses', () => {
  it('タスクステータスを正しく集計する', () => {
    const statuses: TaskStatus[] = ['Todo', 'Doing', 'Done', 'Done', 'Failed'];
    const result = summarizeTaskStatuses(statuses);
    expect(result).toEqual({
      Todo: 1,
      Doing: 1,
      Done: 2,
      Failed: 1,
      Skipped: 0,
      Cancelled: 0,
    });
  });

  it('空配列の場合は全て0を返す', () => {
    const result = summarizeTaskStatuses([]);
    expect(result).toEqual({
      Todo: 0,
      Doing: 0,
      Done: 0,
      Failed: 0,
      Skipped: 0,
      Cancelled: 0,
    });
  });
});

describe('formatStatusSummary', () => {
  it('0件のステータスは表示しない', () => {
    const result = formatStatusSummary({
      Todo: 0,
      Doing: 1,
      Done: 2,
      Failed: 0,
      Skipped: 0,
      Cancelled: 0,
    });
    expect(result).toContain('Doing: 1');
    expect(result).toContain('Done: 2');
    expect(result).not.toContain('Todo');
    expect(result).not.toContain('Failed');
    expect(result).not.toContain('Skipped');
  });

  it('全てのステータスが0件の場合は空文字列を返す', () => {
    const result = formatStatusSummary({
      Todo: 0,
      Doing: 0,
      Done: 0,
      Failed: 0,
      Skipped: 0,
      Cancelled: 0,
    });
    expect(result).toBe('');
  });
});

describe('handleStatus', () => {
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    respond = vi.fn().mockResolvedValue(undefined);
  });

  it('実行中のストーリーがない場合、適切なメッセージを返す', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/stories/story-a.md',
    ] as never);
    mockReadStoryFile.mockReturnValue(makeStory('story-a', 'Done'));

    await handleStatus([], respond);

    expect(respond).toHaveBeenCalledWith('現在実行中のストーリーはありません');
  });

  it('ストーリーファイルが存在しない場合、適切なメッセージを返す', async () => {
    mockGlob.mockResolvedValue([] as never);

    await handleStatus([], respond);

    expect(respond).toHaveBeenCalledWith('現在実行中のストーリーはありません');
  });

  it('Doingのストーリーと配下のタスク状態を表示する', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/stories/my-story.md',
      '/vault/Projects/test-project/stories/other-story.md',
    ] as never);

    mockReadStoryFile
      .mockReturnValueOnce(makeStory('my-story', 'Doing'))
      .mockReturnValueOnce(makeStory('other-story', 'Done'));

    mockGetStoryTasks.mockResolvedValue([
      makeTask('my-story', 'task-01', 'Done'),
      makeTask('my-story', 'task-02', 'Doing'),
      makeTask('my-story', 'task-03', 'Todo'),
    ]);

    await handleStatus([], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;

    // ストーリー名が含まれる
    expect(msg).toContain('my-story');
    // タスク数が含まれる
    expect(msg).toContain('3 tasks');
    // 各タスクのslugが含まれる
    expect(msg).toContain('task-01');
    expect(msg).toContain('task-02');
    expect(msg).toContain('task-03');
    // Done以外のストーリーは含まれない
    expect(msg).not.toContain('other-story');
  });

  it('複数のDoingストーリーを表示する', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/stories/story-a.md',
      '/vault/Projects/test-project/stories/story-b.md',
    ] as never);

    mockReadStoryFile
      .mockReturnValueOnce(makeStory('story-a', 'Doing'))
      .mockReturnValueOnce(makeStory('story-b', 'Doing'));

    mockGetStoryTasks
      .mockResolvedValueOnce([makeTask('story-a', 'a-task-01', 'Done')])
      .mockResolvedValueOnce([makeTask('story-b', 'b-task-01', 'Failed')]);

    await handleStatus([], respond);

    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('story-a');
    expect(msg).toContain('story-b');
    expect(msg).toContain('a-task-01');
    expect(msg).toContain('b-task-01');
    expect(msg).toContain('2');
  });

  it('タスクのないDoingストーリーを正しく表示する', async () => {
    mockGlob.mockResolvedValue([
      '/vault/Projects/test-project/stories/empty-story.md',
    ] as never);

    mockReadStoryFile.mockReturnValue(makeStory('empty-story', 'Doing'));
    mockGetStoryTasks.mockResolvedValue([]);

    await handleStatus([], respond);

    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('empty-story');
    expect(msg).toContain('0 tasks');
  });

  it('エラー時にエラーメッセージを返す', async () => {
    mockGlob.mockRejectedValue(new Error('disk error'));

    await handleStatus([], respond);

    expect(respond).toHaveBeenCalledTimes(1);
    const msg = respond.mock.calls[0][0] as string;
    expect(msg).toContain('エラー');
    expect(msg).toContain('disk error');
  });
});
