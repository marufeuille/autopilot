import { describe, it, expect, vi } from 'vitest';
import { createFakeDeps, defaultReviewLoopResult, defaultCIPollingResult } from './fake-deps';

describe('createFakeDeps', () => {
  it('すべての RunnerDeps メソッドを持つオブジェクトを返す', () => {
    const deps = createFakeDeps();

    expect(deps.runAgent).toBeDefined();
    expect(deps.execGh).toBeDefined();
    expect(deps.execCommand).toBeDefined();
    expect(deps.runReviewLoop).toBeDefined();
    expect(deps.runCIPollingLoop).toBeDefined();
    expect(deps.decomposeTasks).toBeDefined();
    expect(deps.createTaskFile).toBeDefined();
    expect(deps.syncMainBranch).toBeDefined();
    expect(deps.getStoryTasks).toBeDefined();
    expect(deps.updateFileStatus).toBeDefined();
    expect(deps.recordTaskCompletion).toBeDefined();
  });

  it('runAgent はデフォルトで成功を返す', async () => {
    const deps = createFakeDeps();
    await expect(deps.runAgent('test prompt', '/tmp')).resolves.toBeUndefined();
  });

  it('execGh はデフォルトで PR URL を返す', () => {
    const deps = createFakeDeps();
    const result = deps.execGh(['pr', 'create'], '/tmp');
    expect(result).toContain('https://github.com/');
  });

  it('execCommand はデフォルトで空文字列を返す', () => {
    const deps = createFakeDeps();
    const result = deps.execCommand('git push', '/tmp');
    expect(result).toBe('');
  });

  it('runReviewLoop はデフォルトで OK を返す', async () => {
    const deps = createFakeDeps();
    const result = await deps.runReviewLoop('/repo', 'feature/test', 'task content');
    expect(result.finalVerdict).toBe('OK');
    expect(result.escalationRequired).toBe(false);
  });

  it('runCIPollingLoop はデフォルトで success を返す', async () => {
    const deps = createFakeDeps();
    const result = await deps.runCIPollingLoop('/repo', 'feature/test', 'task content');
    expect(result.finalStatus).toBe('success');
  });

  it('decomposeTasks はデフォルトで空配列を返す', async () => {
    const deps = createFakeDeps();
    const result = await deps.decomposeTasks({} as any);
    expect(result).toEqual([]);
  });

  it('getStoryTasks はデフォルトで空配列を返す', async () => {
    const deps = createFakeDeps();
    const result = await deps.getStoryTasks('project', 'story');
    expect(result).toEqual([]);
  });

  it('各メソッドの呼び出し回数・引数を vi.fn() で検証できる', async () => {
    const deps = createFakeDeps();

    await deps.runAgent('my prompt', '/workspace');
    deps.execGh(['pr', 'view'], '/workspace');
    deps.updateFileStatus('/path/to/file.md', 'Done');

    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(deps.runAgent).toHaveBeenCalledWith('my prompt', '/workspace');

    expect(deps.execGh).toHaveBeenCalledTimes(1);
    expect(deps.execGh).toHaveBeenCalledWith(['pr', 'view'], '/workspace');

    expect(deps.updateFileStatus).toHaveBeenCalledTimes(1);
    expect(deps.updateFileStatus).toHaveBeenCalledWith('/path/to/file.md', 'Done');
  });

  it('overrides でメソッドを差し替えられる', async () => {
    const customRunAgent = vi.fn().mockRejectedValue(new Error('agent failed'));
    const customDecompose = vi.fn().mockResolvedValue([
      {
        slug: 'story-01-task',
        title: 'Task 1',
        priority: 'high',
        effort: 'low',
        purpose: 'test',
        detail: 'detail',
        criteria: ['done'],
      },
    ]);

    const deps = createFakeDeps({
      runAgent: customRunAgent,
      decomposeTasks: customDecompose,
    });

    await expect(deps.runAgent('prompt', '/tmp')).rejects.toThrow('agent failed');

    const tasks = await deps.decomposeTasks({} as any);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].slug).toBe('story-01-task');
  });

  it('overrides で一部だけ差し替えても他はデフォルトのまま', async () => {
    const deps = createFakeDeps({
      execGh: vi.fn().mockReturnValue('custom-url'),
    });

    // overrides したもの
    expect(deps.execGh([], '')).toBe('custom-url');

    // overrides していないもの（デフォルト）
    await expect(deps.runAgent('prompt', '/tmp')).resolves.toBeUndefined();
    const review = await deps.runReviewLoop('/repo', 'branch', 'content');
    expect(review.finalVerdict).toBe('OK');
  });
});

describe('defaultReviewLoopResult', () => {
  it('OK verdict を返す', () => {
    const result = defaultReviewLoopResult();
    expect(result.finalVerdict).toBe('OK');
    expect(result.escalationRequired).toBe(false);
    expect(result.iterations).toHaveLength(1);
    expect(result.lastReviewResult.verdict).toBe('OK');
  });
});

describe('defaultCIPollingResult', () => {
  it('success を返す', () => {
    const result = defaultCIPollingResult();
    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.attemptResults).toHaveLength(1);
  });
});
