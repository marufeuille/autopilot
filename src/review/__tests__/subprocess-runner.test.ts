import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// child_process.spawn をモック
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { SubprocessReviewRunner } from '../subprocess-runner';
import { ReviewError, ReviewTimeoutError } from '../types';

/**
 * spawn のモック用ヘルパー: ChildProcess 風オブジェクトを返す
 * stdout/stderr は EventEmitter で data イベントを手動発火する
 */
function createMockChild() {
  const proc = new EventEmitter();
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  let stdinData = '';
  const stdin = {
    write(data: string) {
      stdinData += data;
    },
    end() {},
  };

  const child = Object.assign(proc, {
    stdin,
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    pid: 12345,
    killed: false,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
      return true;
    }),
  });

  return {
    child,
    get stdinData() {
      return stdinData;
    },
    writeStdout(data: string) {
      stdoutEmitter.emit('data', Buffer.from(data));
    },
    writeStderr(data: string) {
      stderrEmitter.emit('data', Buffer.from(data));
    },
    emitClose(code: number | null) {
      proc.emit('close', code);
    },
    emitError(err: Error) {
      proc.emit('error', err);
    },
  };
}

describe('SubprocessReviewRunner', () => {
  let runner: SubprocessReviewRunner;
  let mock: ReturnType<typeof createMockChild>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mock = createMockChild();
    mockSpawn.mockReturnValue(mock.child);

    runner = new SubprocessReviewRunner({
      timeoutMs: 10000,
      tsNodePath: '/usr/bin/ts-node',
      workerPath: '/path/to/worker.ts',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should spawn worker process with correct arguments', async () => {
    const reviewPromise = runner.review('diff content');

    const result = { verdict: 'OK' as const, summary: 'All good', findings: [] };
    mock.writeStdout(JSON.stringify(result));
    mock.emitClose(0);

    await reviewPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/ts-node',
      ['/path/to/worker.ts'],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  });

  it('should pass diff and taskDescription to worker via stdin', async () => {
    const reviewPromise = runner.review('test diff', 'task description');

    const result = { verdict: 'OK' as const, summary: 'LGTM', findings: [] };
    mock.writeStdout(JSON.stringify(result));
    mock.emitClose(0);

    await reviewPromise;

    const stdinParsed = JSON.parse(mock.stdinData);
    expect(stdinParsed).toEqual({
      diff: 'test diff',
      taskDescription: 'task description',
    });
  });

  it('should return ReviewResult on success with OK verdict', async () => {
    const reviewPromise = runner.review('some diff');

    const expected = { verdict: 'OK' as const, summary: 'No issues found', findings: [] };
    mock.writeStdout(JSON.stringify(expected));
    mock.emitClose(0);

    const result = await reviewPromise;
    expect(result).toEqual(expected);
  });

  it('should return ReviewResult with NG verdict and findings', async () => {
    const reviewPromise = runner.review('buggy diff');

    const expected = {
      verdict: 'NG' as const,
      summary: 'Found critical issues',
      findings: [
        { file: 'src/foo.ts', line: 42, severity: 'error' as const, message: 'Null pointer dereference' },
        { severity: 'warning' as const, message: 'Consider using const' },
      ],
    };
    mock.writeStdout(JSON.stringify(expected));
    mock.emitClose(0);

    const result = await reviewPromise;
    expect(result).toEqual(expected);
  });

  it('should throw ReviewTimeoutError when process times out', async () => {
    const reviewPromise = runner.review('slow diff');

    // タイムアウトを発火
    vi.advanceTimersByTime(10000);

    // close イベント（SIGTERM後にOSがプロセスを閉じる）
    mock.emitClose(null);

    await expect(reviewPromise).rejects.toThrow(ReviewTimeoutError);
    await expect(reviewPromise).rejects.toThrow('timed out after 10000ms');
    expect(mock.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should throw ReviewError when worker exits with non-zero code', async () => {
    const reviewPromise = runner.review('bad diff');

    mock.writeStderr('Something went wrong');
    mock.emitClose(1);

    await expect(reviewPromise).rejects.toThrow(ReviewError);
    await expect(reviewPromise).rejects.toThrow('exited with code 1');
  });

  it('should extract error message from worker stdout on non-zero exit', async () => {
    const reviewPromise = runner.review('bad diff');

    mock.writeStdout(JSON.stringify({ error: 'Agent execution failed: API error' }));
    mock.emitClose(1);

    await expect(reviewPromise).rejects.toThrow('Agent execution failed: API error');
  });

  it('should throw ReviewError when spawn fails', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(runner.review('diff')).rejects.toThrow(ReviewError);
    await expect(runner.review('diff')).rejects.toThrow('Failed to spawn');
  });

  it('should throw ReviewError on process error event', async () => {
    const reviewPromise = runner.review('diff');

    mock.emitError(new Error('Process crashed'));

    await expect(reviewPromise).rejects.toThrow(ReviewError);
    await expect(reviewPromise).rejects.toThrow('Process crashed');
  });

  it('should throw ReviewError when stdout is not valid JSON', async () => {
    const reviewPromise = runner.review('diff');

    mock.writeStdout('not json at all');
    mock.emitClose(0);

    await expect(reviewPromise).rejects.toThrow(ReviewError);
    await expect(reviewPromise).rejects.toThrow('Failed to parse');
  });

  it('should throw ReviewError when verdict is invalid', async () => {
    const reviewPromise = runner.review('diff');

    mock.writeStdout(JSON.stringify({
      verdict: 'MAYBE',
      summary: 'Unsure',
      findings: [],
    }));
    mock.emitClose(0);

    await expect(reviewPromise).rejects.toThrow(ReviewError);
    await expect(reviewPromise).rejects.toThrow('Invalid verdict');
  });

  it('should throw ReviewError when diff is empty', async () => {
    await expect(runner.review('')).rejects.toThrow(ReviewError);
    await expect(runner.review('')).rejects.toThrow('non-empty string');
  });

  it('should use default options when none provided', () => {
    const defaultRunner = new SubprocessReviewRunner();
    expect(defaultRunner).toBeInstanceOf(SubprocessReviewRunner);
  });

  it('should accept reviewBackend via constructor DI', () => {
    const mockBackend = { run: vi.fn().mockResolvedValue('result') };
    const runnerWithBackend = new SubprocessReviewRunner({
      reviewBackend: mockBackend,
    });
    expect(runnerWithBackend).toBeInstanceOf(SubprocessReviewRunner);
    expect(runnerWithBackend.reviewBackend).toBe(mockBackend);
  });

  it('should have undefined reviewBackend when not provided', () => {
    const defaultRunner = new SubprocessReviewRunner();
    expect(defaultRunner.reviewBackend).toBeUndefined();
  });
});
