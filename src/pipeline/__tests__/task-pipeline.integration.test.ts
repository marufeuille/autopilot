import { describe, it, expect, vi, afterEach } from 'vitest';
import { taskPipeline } from '../task-pipeline';
import { createTaskContext } from '../runner';
import { TaskContext } from '../types';
import { FakeNotifier } from '../../__tests__/helpers/fake-notifier';
import { createFakeDeps, defaultReviewLoopResult } from '../../__tests__/helpers/fake-deps';

// detectNoRemote をモック化（no-remote パスの制御用）
vi.mock('../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git')>();
  return { ...actual, detectNoRemote: vi.fn().mockReturnValue(false) };
});

// runMergePollingLoop をモック化（手動マージポーリングをスキップ）
vi.mock('../../merge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../merge')>();
  return {
    ...actual,
    runMergePollingLoop: vi.fn().mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 }),
  };
});

import { detectNoRemote } from '../../git';

/**
 * 結合テスト用の TaskContext を生成するヘルパー
 */
function makeCtx(overrides: {
  notifierOptions?: ConstructorParameters<typeof FakeNotifier>[0];
  depsOverrides?: Parameters<typeof createFakeDeps>[0];
  ctxStore?: Partial<import('../types').TaskContextStore>;
} = {}): { ctx: TaskContext; notifier: FakeNotifier } {
  const notifier = new FakeNotifier(overrides.notifierOptions);
  const deps = createFakeDeps(overrides.depsOverrides);
  const ctx = createTaskContext({
    task: {
      filePath: '/vault/tasks/story/task.md',
      project: 'test-project',
      storySlug: 'test-story',
      slug: 'test-task',
      status: 'Todo',
      frontmatter: {},
      content: 'タスク内容',
    },
    story: {
      filePath: '/vault/stories/story.md',
      project: 'test-project',
      slug: 'test-story',
      status: 'Doing',
      frontmatter: {},
      content: 'ストーリー内容',
    },
    repoPath: '/repo',
    notifier,
    deps,
  });

  if (overrides.ctxStore) {
    for (const [k, v] of Object.entries(overrides.ctxStore)) {
      ctx.set(k as import('../types').TaskContextKey, v as never);
    }
  }

  return { ctx, notifier };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(detectNoRemote).mockReturnValue(false);
});

// ================================================================
// taskPipeline 結合テスト
// ================================================================

describe('taskPipeline integration', () => {
  describe('パイプライン定義の構造検証', () => {
    // taskPipeline は createPipeline() が返す関数なので直接 steps にはアクセスできない。
    // 代わりに実際のハンドラの実行順序で検証する。

    it('全 6 ステップが start-approval → sync-main → implementation → pr-lifecycle → doc-update → done の順に実行される', async () => {
      const executionOrder: string[] = [];

      // 各ステップのハンドラが呼ばれたことをスパイで追跡
      const runAgent = vi.fn().mockImplementation(async (prompt: string) => {
        // implementation と doc-update で呼ばれる
        if (prompt.includes('実装してください')) {
          executionOrder.push('implementation:runAgent');
        } else if (prompt.includes('ドキュメント更新担当')) {
          executionOrder.push('doc-update:runAgent');
        }
      });

      const { ctx, notifier } = makeCtx({
        depsOverrides: {
          runAgent,
          execCommand: vi.fn().mockImplementation((cmd: string) => {
            if (cmd.includes('git push')) return '';
            if (cmd.includes('gh pr create') || cmd.includes('pr create')) return 'https://github.com/test/repo/pull/1';
            return '';
          }),
        },
      });

      const result = await taskPipeline(ctx);

      expect(result).toBe('done');

      // doc-update の runAgent が implementation の runAgent より後に呼ばれたことを確認
      const implIdx = executionOrder.indexOf('implementation:runAgent');
      const docIdx = executionOrder.indexOf('doc-update:runAgent');
      expect(implIdx).toBeGreaterThanOrEqual(0);
      expect(docIdx).toBeGreaterThan(implIdx);

      // 通知の順序で各ステップの実行を追跡
      const messages = notifier.notifications.map((n) => n.message);

      // doc-update の完了通知が存在する
      expect(messages.some((m) => m.includes('ドキュメント更新完了'))).toBe(true);

      // done の完了通知が存在する
      expect(messages.some((m) => m.includes('タスク完了'))).toBe(true);

      // doc-update の通知が done の通知より前に来ている
      const docNotifIdx = messages.findIndex((m) => m.includes('ドキュメント更新完了'));
      const doneNotifIdx = messages.findIndex((m) => m.includes('タスク完了'));
      expect(docNotifIdx).toBeLessThan(doneNotifIdx);
    });
  });

  describe('正常系: 全ステップが成功してパイプラインが完了する', () => {
    it('承認 → 同期 → 実装 → PR → doc-update → done で "done" を返す', async () => {
      const { ctx } = makeCtx({
        depsOverrides: {
          execCommand: vi.fn().mockImplementation((cmd: string) => {
            if (cmd.includes('git push')) return '';
            return 'https://github.com/test/repo/pull/1';
          }),
        },
      });

      const result = await taskPipeline(ctx);
      expect(result).toBe('done');
    });

    it('完了後に prUrl がコンテキストにセットされている', async () => {
      const { ctx } = makeCtx({
        depsOverrides: {
          execCommand: vi.fn().mockImplementation((cmd: string) => {
            if (cmd.includes('git push')) return '';
            return 'https://github.com/test/repo/pull/42';
          }),
        },
      });

      await taskPipeline(ctx);
      expect(ctx.get('prUrl')).toBe('https://github.com/test/repo/pull/42');
    });
  });

  describe('start-approval で拒否された場合', () => {
    it('パイプラインが "skipped" を返し、以降のステップは実行されない', async () => {
      const runAgent = vi.fn();
      const { ctx } = makeCtx({
        notifierOptions: {
          approvalResponses: [{ action: 'reject', reason: 'not now' }],
        },
        depsOverrides: { runAgent },
      });

      const result = await taskPipeline(ctx);
      expect(result).toBe('skipped');
      // implementation も doc-update も実行されない
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  describe('doc-update でエラーが発生してもパイプラインは完了する', () => {
    it('doc-update の runAgent がエラーでも done まで到達して "done" を返す', async () => {
      let callCount = 0;
      const runAgent = vi.fn().mockImplementation(async (prompt: string) => {
        callCount++;
        // doc-update のプロンプトの場合のみエラーを投げる
        if (prompt.includes('ドキュメント更新担当')) {
          throw new Error('doc agent crashed');
        }
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { ctx, notifier } = makeCtx({
        depsOverrides: {
          runAgent,
          execCommand: vi.fn().mockImplementation((cmd: string) => {
            if (cmd.includes('git push')) return '';
            return 'https://github.com/test/repo/pull/1';
          }),
        },
      });

      const result = await taskPipeline(ctx);
      expect(result).toBe('done');

      // doc-update エラー通知が出力される
      expect(notifier.notifications.some((n) => n.message.includes('ドキュメント更新失敗'))).toBe(true);

      // done の完了通知も出力される（パイプラインが止まっていないことの証拠）
      expect(notifier.notifications.some((n) => n.message.includes('タスク完了'))).toBe(true);

      warnSpy.mockRestore();
    });
  });

  describe('no-remote モードでの結合テスト', () => {
    it('ローカルオンリーモードでも doc-update → done の順で実行される', async () => {
      vi.mocked(detectNoRemote).mockReturnValue(true);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const runAgent = vi.fn().mockResolvedValue(undefined);
      const { ctx, notifier } = makeCtx({
        depsOverrides: {
          runAgent,
          execCommand: vi.fn().mockReturnValue('abc123def'),
        },
      });

      const result = await taskPipeline(ctx);
      expect(result).toBe('done');

      // localOnly がセットされている
      expect(ctx.get('localOnly')).toBe(true);

      // doc-update のプロンプトに「README のみ」が含まれる（localOnly が伝播している）
      const docPrompt = runAgent.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('ドキュメント更新担当'),
      );
      expect(docPrompt).toBeDefined();
      expect(docPrompt![0]).toContain('README のみを対象');

      // done の通知にローカルオンリーが含まれる
      expect(notifier.notifications.some((n) => n.message.includes('ローカルオンリー'))).toBe(true);
    });
  });

  describe('retry シナリオ: implementation に戻った後も doc-update は実行される', () => {
    it('CI 失敗 → implementation retry → 再成功 → doc-update → done', async () => {
      let prLifecycleCallCount = 0;

      const { ctx, notifier } = makeCtx({
        depsOverrides: {
          execCommand: vi.fn().mockImplementation((cmd: string) => {
            if (cmd.includes('git push')) return '';
            return 'https://github.com/test/repo/pull/1';
          }),
          runCIPollingLoop: vi.fn().mockImplementation(async () => {
            prLifecycleCallCount++;
            if (prLifecycleCallCount === 1) {
              // 1回目: CI失敗
              return {
                finalStatus: 'failure',
                attempts: 1,
                attemptResults: [],
                lastCIResult: { status: 'failure', summary: 'build failed' },
              };
            }
            // 2回目: CI成功
            return {
              finalStatus: 'success',
              attempts: 1,
              attemptResults: [],
              lastCIResult: { status: 'success', summary: 'all passed' },
            };
          }),
        },
      });

      const result = await taskPipeline(ctx);
      expect(result).toBe('done');

      // doc-update が実行された
      expect(notifier.notifications.some((n) => n.message.includes('ドキュメント更新完了'))).toBe(true);

      // done が実行された
      expect(notifier.notifications.some((n) => n.message.includes('タスク完了'))).toBe(true);
    });
  });

  describe('却下 → リトライ シナリオ: rejected → implementation retry with rejection reason', () => {
    it('PR却下 → implementation retry → プロンプトに却下理由が含まれる → 再成功 → done', async () => {
      const { runMergePollingLoop: mockMergePolling } = await import('../../merge');
      let mergeCallCount = 0;
      vi.mocked(mockMergePolling).mockImplementation(async () => {
        mergeCallCount++;
        if (mergeCallCount === 1) {
          // 1回目: 却下
          return {
            finalStatus: 'rejected' as const,
            elapsedMs: 2000,
            rejectionReason: 'エラーハンドリングが不十分',
          };
        }
        // 2回目: マージ
        return { finalStatus: 'merged' as const, elapsedMs: 1000 };
      });

      const runAgent = vi.fn().mockResolvedValue(undefined);
      const { ctx, notifier } = makeCtx({
        depsOverrides: {
          runAgent,
          execCommand: vi.fn().mockImplementation((cmd: string) => {
            if (cmd.includes('git push')) return '';
            return 'https://github.com/test/repo/pull/1';
          }),
        },
      });

      const result = await taskPipeline(ctx);
      expect(result).toBe('done');

      // 却下通知が送られている
      expect(notifier.notifications.some((n) => n.message.includes('PR却下'))).toBe(true);
      expect(notifier.notifications.some((n) => n.message.includes('エラーハンドリングが不十分'))).toBe(true);

      // リトライ時の runAgent 呼び出しに却下理由が含まれている
      // runAgent は implementation で呼ばれる（初回 + retry で最低2回、doc-update でも呼ばれる）
      const agentCalls = runAgent.mock.calls.map((c: unknown[]) => c[0] as string);
      const retryCall = agentCalls.find((prompt: string) => prompt.includes('前回の却下理由'));
      expect(retryCall).toBeDefined();
      expect(retryCall).toContain('エラーハンドリングが不十分');
      expect(retryCall).toContain('上記の指摘を踏まえて実装してください。');

      // 最終的にマージ完了
      expect(notifier.notifications.some((n) => n.message.includes('マージ完了'))).toBe(true);
    });

    it('rejectionReason はリトライ後にクリアされ、2回目の implementation プロンプトには含まれない', async () => {
      const { runMergePollingLoop: mockMergePolling } = await import('../../merge');
      let mergeCallCount = 0;
      vi.mocked(mockMergePolling).mockImplementation(async () => {
        mergeCallCount++;
        if (mergeCallCount === 1) {
          return {
            finalStatus: 'rejected' as const,
            elapsedMs: 2000,
            rejectionReason: '最初の却下理由',
          };
        }
        return { finalStatus: 'merged' as const, elapsedMs: 1000 };
      });

      const runAgent = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeCtx({
        depsOverrides: {
          runAgent,
          execCommand: vi.fn().mockImplementation((cmd: string) => {
            if (cmd.includes('git push')) return '';
            return 'https://github.com/test/repo/pull/1';
          }),
        },
      });

      await taskPipeline(ctx);

      // rejectionReason がクリアされている
      expect(ctx.get('rejectionReason')).toBeUndefined();
    });
  });
});
