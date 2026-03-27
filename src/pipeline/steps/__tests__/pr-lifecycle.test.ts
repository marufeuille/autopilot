import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoryFile, TaskFile } from '../../../vault/reader';

// 外部パッケージの transitive import をモック
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}));

vi.mock('gray-matter', () => ({
  default: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: vi.fn(),
}));

// fs の writeFileSync / unlinkSync をモック（PR body一時ファイルで使われる）
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock('fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

// child_process をモック（transitive import で必要）
vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => ''),
}));

import { formatReviewSummaryForPR, createPullRequest, buildPRBody, updatePullRequestBody } from '../pr-lifecycle';

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

describe('buildPRBody', () => {
  it('タスク・ストーリー情報とレビューサマリーを含むPR本文を生成する', () => {
    const task = createTask('task-01', 'Todo');
    const story = createStory();
    const reviewSummary = '## セルフレビュー結果\n\n✅ **セルフレビュー通過**';

    const body = buildPRBody(task, story, reviewSummary);

    expect(body).toContain('## 概要');
    expect(body).toContain('タスク: task-01');
    expect(body).toContain('ストーリー: my-story');
    expect(body).toContain(task.content);
    expect(body).toContain(reviewSummary);
  });

  it('異なるタスク・ストーリーの値が正しく反映される', () => {
    const task = createTask('another-task', 'Doing');
    const story = createStory({ slug: 'another-story' });
    const reviewSummary = '## セルフレビュー結果\n\n⚠️ **セルフレビュー未通過**';

    const body = buildPRBody(task, story, reviewSummary);

    expect(body).toContain('タスク: another-task');
    expect(body).toContain('ストーリー: another-story');
    expect(body).toContain('セルフレビュー未通過');
  });
});

describe('createPullRequest', () => {
  const mockExecCommand = vi.fn();
  const mockExecGh = vi.fn();

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

    mockExecCommand
      .mockReturnValueOnce('') // git push
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr create

    const url = createPullRequest('/repo', 'feature/task-01', task, story, reviewResult, {
      execCommand: mockExecCommand,
      execGh: mockExecGh,
    });

    expect(url).toBe('https://github.com/test/repo/pull/1');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);

    // PR新規作成成功時はupdatePullRequestBody（execGh）が呼ばれない
    expect(mockExecGh).not.toHaveBeenCalled();

    // git push の呼び出し確認
    expect(mockExecCommand).toHaveBeenCalledWith(
      'git push -u origin feature/task-01',
      '/repo',
    );

    // gh pr create の呼び出し確認（--body-file で一時ファイル経由）
    const prCreateCall = mockExecCommand.mock.calls[1];
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

  it('PR作成が失敗した場合に既存PRのURL取得とPR本文更新を行う', () => {
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

    mockExecCommand
      .mockReturnValueOnce('') // git push
      .mockImplementationOnce(() => { throw new Error('PR already exists'); }) // gh pr create
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr view fallback
    mockExecGh.mockReturnValueOnce(''); // gh pr edit

    const url = createPullRequest('/repo', 'feature/task-01', task, story, reviewResult, {
      execCommand: mockExecCommand,
      execGh: mockExecGh,
    });

    expect(url).toBe('https://github.com/test/repo/pull/1');
    expect(mockExecCommand).toHaveBeenCalledTimes(3);

    // gh pr edit が呼ばれてPR本文が更新されていることを確認
    expect(mockExecGh).toHaveBeenCalledTimes(1);
    const ghArgs = mockExecGh.mock.calls[0][0] as string[];
    expect(ghArgs[0]).toBe('pr');
    expect(ghArgs[1]).toBe('edit');
    expect(ghArgs[2]).toBe('feature/task-01');
    expect(ghArgs[3]).toBe('--body-file');
  });

  it('PR本文更新が失敗してもPR URLは返され処理が継続する', () => {
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

    mockExecCommand
      .mockReturnValueOnce('') // git push
      .mockImplementationOnce(() => { throw new Error('PR already exists'); }) // gh pr create
      .mockReturnValueOnce('https://github.com/test/repo/pull/1'); // gh pr view fallback
    mockExecGh.mockImplementationOnce(() => { throw new Error('gh pr edit failed'); }); // gh pr edit fails

    const url = createPullRequest('/repo', 'feature/task-01', task, story, reviewResult, {
      execCommand: mockExecCommand,
      execGh: mockExecGh,
    });

    // 本文更新が失敗してもURLは正しく返される
    expect(url).toBe('https://github.com/test/repo/pull/1');
    expect(mockExecGh).toHaveBeenCalledTimes(1);
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

    mockExecCommand
      .mockImplementationOnce(() => { throw new Error('push failed'); }); // git push fails

    const url = createPullRequest('/repo', 'feature/task-01', task, story, reviewResult, {
      execCommand: mockExecCommand,
    });

    expect(url).toBe('');
  });
});

describe('updatePullRequestBody', () => {
  const mockExecGh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('一時ファイルに本文を書き出してgh pr editで更新する', () => {
    mockExecGh.mockReturnValueOnce('');

    updatePullRequestBody('/repo', 'feature/task-01', '## 新しい本文', {
      execGh: mockExecGh,
    });

    // 一時ファイルにbodyが書き出されていることを確認
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync.mock.calls[0][1]).toBe('## 新しい本文');

    // execGh が引数配列で呼ばれていることを確認（コマンドインジェクション対策）
    expect(mockExecGh).toHaveBeenCalledTimes(1);
    const args = mockExecGh.mock.calls[0][0] as string[];
    expect(args[0]).toBe('pr');
    expect(args[1]).toBe('edit');
    expect(args[2]).toBe('feature/task-01');
    expect(args[3]).toBe('--body-file');
    expect(typeof args[4]).toBe('string'); // 一時ファイルパス
    expect(mockExecGh.mock.calls[0][1]).toBe('/repo');

    // 一時ファイルが削除されていることを確認
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });

  it('gh pr editが失敗した場合にエラーを投げ、一時ファイルはクリーンアップされる', () => {
    mockExecGh.mockImplementationOnce(() => {
      throw new Error('gh pr edit failed');
    });

    expect(() =>
      updatePullRequestBody('/repo', 'feature/task-01', '## 本文', {
        execGh: mockExecGh,
      }),
    ).toThrow('gh pr edit failed');

    // 一時ファイルが書き出されたことを確認
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    // エラー時でも一時ファイルが削除されていることを確認
    expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
  });
});
