import { describe, it, expect, vi } from 'vitest';
import { createPipeline, createTaskContext, step } from '../runner';
import { FlowSignal, RetryContext, TaskContext } from '../types';

// テスト用の最小限の TaskContext を生成するヘルパー
function makeCtx(): TaskContext {
  return createTaskContext({
    task: { filePath: '', project: '', storySlug: '', slug: 'test-task', status: 'Todo', frontmatter: {}, content: '' },
    story: { filePath: '', project: '', slug: 'test-story', status: 'Doing', frontmatter: {}, content: '' },
    repoPath: '/tmp/test',
    notifier: {
      notify: vi.fn(),
      requestApproval: vi.fn(),
      startThread: vi.fn(),
      getThreadTs: vi.fn(),
      endSession: vi.fn(),
    } as unknown as TaskContext['notifier'],
    deps: {} as TaskContext['deps'],
  });
}

describe('RetryContext', () => {
  describe('createTaskContext の getRetryContext / setRetryContext', () => {
    it('初期状態では undefined を返す', () => {
      const ctx = makeCtx();
      expect(ctx.getRetryContext()).toBeUndefined();
    });

    it('setRetryContext で設定した値を getRetryContext で取得できる', () => {
      const ctx = makeCtx();
      const retryCtx: RetryContext = {
        reason: 'セルフレビュー未通過',
        diffStat: ' src/foo.ts | 10 +\n 1 file changed',
        reviewSummary: '型安全性に問題があります',
        errorFindings: [
          { file: 'src/foo.ts', line: 42, severity: 'error', message: '未使用の変数' },
        ],
      };
      ctx.setRetryContext(retryCtx);
      expect(ctx.getRetryContext()).toEqual(retryCtx);
    });

    it('setRetryContext は retryReason も同期する（後方互換）', () => {
      const ctx = makeCtx();
      ctx.setRetryContext({ reason: 'CI失敗' });
      expect(ctx.getRetryReason()).toBe('CI失敗');
    });

    it('reason のみの RetryContext を設定できる', () => {
      const ctx = makeCtx();
      const retryCtx: RetryContext = { reason: 'PRクローズ' };
      ctx.setRetryContext(retryCtx);

      const result = ctx.getRetryContext();
      expect(result).toEqual({ reason: 'PRクローズ' });
      expect(result?.diffStat).toBeUndefined();
      expect(result?.reviewSummary).toBeUndefined();
      expect(result?.errorFindings).toBeUndefined();
    });

    it('get/set 経由でも retryContext にアクセスできる', () => {
      const ctx = makeCtx();
      const retryCtx: RetryContext = { reason: 'test', reviewSummary: 'summary' };
      ctx.set('retryContext', retryCtx);
      expect(ctx.get('retryContext')).toEqual(retryCtx);
    });
  });

  describe('Pipeline retry 時の retryContext 自動設定', () => {
    it('retry シグナル発生時に retryContext が reason のみで自動設定される', async () => {
      let callCount = 0;
      const retriable = vi.fn(async (_ctx: TaskContext): Promise<FlowSignal> => {
        callCount++;
        return callCount === 1
          ? { kind: 'retry', from: 'a', reason: 'first attempt failed' }
          : { kind: 'continue' };
      });

      const run = createPipeline([
        step('a', vi.fn(async () => ({ kind: 'continue' }) as FlowSignal)),
        step('b', retriable),
      ]);

      const ctx = makeCtx();
      await run(ctx);

      expect(ctx.getRetryContext()).toEqual({ reason: 'first attempt failed' });
      // 後方互換: retryReason も設定される
      expect(ctx.getRetryReason()).toBe('first attempt failed');
    });

    it('step 側で事前に retryContext を設定した場合、pipeline は上書きしない', async () => {
      let callCount = 0;
      const retriable = vi.fn(async (ctx: TaskContext): Promise<FlowSignal> => {
        callCount++;
        if (callCount === 1) {
          // step 側で詳細な retryContext を設定してから retry シグナルを返す
          ctx.setRetryContext({
            reason: 'セルフレビュー未通過',
            diffStat: ' src/foo.ts | 5 +\n 1 file changed',
            reviewSummary: 'エラーあり',
            errorFindings: [
              { file: 'src/foo.ts', line: 10, severity: 'error', message: '型エラー' },
            ],
          });
          return { kind: 'retry', from: 'a', reason: 'セルフレビュー未通過' };
        }
        return { kind: 'continue' };
      });

      const run = createPipeline([
        step('a', vi.fn(async () => ({ kind: 'continue' }) as FlowSignal)),
        step('b', retriable),
      ]);

      const ctx = makeCtx();
      await run(ctx);

      // step 側で設定した詳細な retryContext がそのまま保持される
      const retryCtx = ctx.getRetryContext();
      expect(retryCtx?.reason).toBe('セルフレビュー未通過');
      expect(retryCtx?.diffStat).toBe(' src/foo.ts | 5 +\n 1 file changed');
      expect(retryCtx?.reviewSummary).toBe('エラーあり');
      expect(retryCtx?.errorFindings).toHaveLength(1);
      expect(retryCtx?.errorFindings?.[0].severity).toBe('error');
    });
  });

  describe('RetryContext 型の構造', () => {
    it('errorFindings は severity=error のみを想定した型', () => {
      const retryCtx: RetryContext = {
        reason: 'test',
        errorFindings: [
          { file: 'a.ts', line: 1, severity: 'error', message: 'msg1' },
          { severity: 'error', message: 'msg2' },
        ],
      };
      // errorFindings の各要素が ReviewFinding 型に適合する
      expect(retryCtx.errorFindings).toHaveLength(2);
      expect(retryCtx.errorFindings![0].file).toBe('a.ts');
      expect(retryCtx.errorFindings![1].file).toBeUndefined();
    });
  });
});
