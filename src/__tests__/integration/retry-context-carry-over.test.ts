import { describe, it, expect, vi } from 'vitest';
import { createTaskContext, createPipeline, step } from '../../pipeline/runner';
import { TaskContext, FlowSignal, RetryContext } from '../../pipeline/types';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps, defaultReviewLoopResult } from '../helpers/fake-deps';
import { buildRetryContext } from '../../review/context';
import { truncateDiffStat, formatErrorFindings, MAX_DIFF_STAT_LENGTH, MAX_DIFF_STAT_LINES } from '../../pipeline/steps/implementation';
import type { ReviewLoopResult } from '../../review/loop';
import type { ReviewFinding } from '../../review/types';

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

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// detectNoRemote をモック化
vi.mock('../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git')>();
  return { ...actual, detectNoRemote: vi.fn().mockReturnValue(false) };
});

// runMergePollingLoop をモック化
vi.mock('../../merge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../merge')>();
  return {
    ...actual,
    runMergePollingLoop: vi.fn().mockResolvedValue({ finalStatus: 'merged', elapsedMs: 1000 }),
  };
});

// handleImplementation を実際に使う
import { handleImplementation } from '../../pipeline/steps/implementation';

// ---------------------------------------------------------------------------
// テスト用ファクトリ
// ---------------------------------------------------------------------------

function makeCtx(overrides: {
  depsOverrides?: Parameters<typeof createFakeDeps>[0];
  ctxStore?: Partial<import('../../pipeline/types').TaskContextStore>;
} = {}): { ctx: TaskContext; notifier: FakeNotifier } {
  const notifier = new FakeNotifier();
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
      ctx.set(k as import('../../pipeline/types').TaskContextKey, v as never);
    }
  }

  return { ctx, notifier };
}

/**
 * ERROR + WARNING 混在の ReviewLoopResult を生成する
 */
function createMixedReviewResult(): ReviewLoopResult {
  return {
    finalVerdict: 'NG',
    escalationRequired: true,
    iterations: [
      {
        iteration: 1,
        reviewResult: {
          verdict: 'NG',
          summary: 'テストカバレッジ不足と命名に問題があります',
          findings: [
            { file: 'src/handler.ts', line: 42, severity: 'error', message: '未処理の例外があります' },
            { file: 'src/utils.ts', severity: 'error', message: 'エラーハンドリングが不足しています' },
            { file: 'src/config.ts', line: 10, severity: 'warning', message: '変数名が不適切です' },
            { file: 'src/types.ts', severity: 'info', message: 'ドキュメント追加を推奨' },
          ],
        },
        timestamp: new Date(),
      },
    ],
    lastReviewResult: {
      verdict: 'NG',
      summary: 'テストカバレッジ不足と命名に問題があります',
      findings: [
        { file: 'src/handler.ts', line: 42, severity: 'error', message: '未処理の例外があります' },
        { file: 'src/utils.ts', severity: 'error', message: 'エラーハンドリングが不足しています' },
        { file: 'src/config.ts', line: 10, severity: 'warning', message: '変数名が不適切です' },
        { file: 'src/types.ts', severity: 'info', message: 'ドキュメント追加を推奨' },
      ],
    },
    warnings: [
      { file: 'src/config.ts', line: 10, severity: 'warning', message: '変数名が不適切です' },
    ],
  };
}

// ===========================================================================
// 統合テスト: retry 文脈引き継ぎ（Context Carry-Over）
// ===========================================================================

describe('Context Carry-Over 統合テスト', () => {

  // -------------------------------------------------------------------------
  // E2E: ReviewLoopResult → buildRetryContext → retryContext → buildRetryPrompt
  // -------------------------------------------------------------------------

  describe('ReviewLoopResult から retry プロンプト生成までのフロー', () => {

    it('ERROR + WARNING 混在の ReviewLoopResult から ERROR のみがプロンプトに含まれ WARNING は含まれない', async () => {
      const mixedResult = createMixedReviewResult();
      const diffStatOutput = ' src/handler.ts | 42 +++\n src/utils.ts | 10 +\n 2 files changed, 52 insertions(+)';

      const runAgent = vi.fn().mockResolvedValue(undefined);
      // 1回目: レビューNG → retryContext がセット
      // 2回目: retryContext を使ったリトライプロンプト
      let callCount = 0;
      const runReviewLoop = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mixedResult : defaultReviewLoopResult();
      });
      const execCommand = vi.fn().mockReturnValue(diffStatOutput);

      const { ctx } = makeCtx({
        depsOverrides: { runAgent, runReviewLoop, execCommand },
      });

      // 1回目: レビューNG → retry signal
      const signal1 = await handleImplementation(ctx);
      expect(signal1.kind).toBe('retry');

      // 2回目: retryContext が反映されたプロンプトで実行
      await handleImplementation(ctx);
      const retryPrompt = runAgent.mock.calls[1][0] as string;

      // ERROR がプロンプトに含まれる
      expect(retryPrompt).toContain('修正が必要なエラー');
      expect(retryPrompt).toContain('src/handler.ts:42');
      expect(retryPrompt).toContain('未処理の例外があります');
      expect(retryPrompt).toContain('src/utils.ts');
      expect(retryPrompt).toContain('エラーハンドリングが不足しています');

      // WARNING はプロンプトに含まれない
      expect(retryPrompt).not.toContain('変数名が不適切です');
      // INFO もプロンプトに含まれない
      expect(retryPrompt).not.toContain('ドキュメント追加を推奨');
    });

    it('diff stat がプロンプトに含まれる', async () => {
      const mixedResult = createMixedReviewResult();
      const diffStatOutput = ' src/handler.ts | 42 +++\n src/utils.ts | 10 +\n 2 files changed, 52 insertions(+)';

      const runAgent = vi.fn().mockResolvedValue(undefined);
      let callCount = 0;
      const runReviewLoop = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mixedResult : defaultReviewLoopResult();
      });
      const execCommand = vi.fn().mockReturnValue(diffStatOutput);

      const { ctx } = makeCtx({
        depsOverrides: { runAgent, runReviewLoop, execCommand },
      });

      // 1回目: レビューNG
      await handleImplementation(ctx);
      // 2回目: リトライ
      await handleImplementation(ctx);
      const retryPrompt = runAgent.mock.calls[1][0] as string;

      expect(retryPrompt).toContain('前回の変更概要');
      expect(retryPrompt).toContain('src/handler.ts | 42 +++');
      expect(retryPrompt).toContain('2 files changed, 52 insertions(+)');
    });

    it('summary がプロンプトに含まれる', async () => {
      const mixedResult = createMixedReviewResult();

      const runAgent = vi.fn().mockResolvedValue(undefined);
      let callCount = 0;
      const runReviewLoop = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mixedResult : defaultReviewLoopResult();
      });

      const { ctx } = makeCtx({
        depsOverrides: { runAgent, runReviewLoop },
      });

      await handleImplementation(ctx);
      await handleImplementation(ctx);
      const retryPrompt = runAgent.mock.calls[1][0] as string;

      expect(retryPrompt).toContain('レビュー結果サマリ');
      expect(retryPrompt).toContain('テストカバレッジ不足と命名に問題があります');
    });
  });

  // -------------------------------------------------------------------------
  // buildRetryContext: ReviewLoopResult → RetryContext 変換の検証
  // -------------------------------------------------------------------------

  describe('buildRetryContext の ERROR フィルタリング', () => {

    it('ERROR のみ抽出し WARNING / INFO を除外する', () => {
      const mixedResult = createMixedReviewResult();
      const retryCtx = buildRetryContext(mixedResult);

      expect(retryCtx.reason).toBe('セルフレビュー未通過');
      expect(retryCtx.reviewSummary).toBe('テストカバレッジ不足と命名に問題があります');

      // errorFindings は error severity のみ
      expect(retryCtx.errorFindings).toBeDefined();
      expect(retryCtx.errorFindings!.length).toBe(2);
      expect(retryCtx.errorFindings!.every(f => f.severity === 'error')).toBe(true);

      // WARNING / INFO のメッセージが含まれない
      const messages = retryCtx.errorFindings!.map(f => f.message);
      expect(messages).not.toContain('変数名が不適切です');
      expect(messages).not.toContain('ドキュメント追加を推奨');
    });

    it('ERROR がない場合は errorFindings が undefined', () => {
      const warningOnlyResult: ReviewLoopResult = {
        finalVerdict: 'NG',
        escalationRequired: true,
        iterations: [{
          iteration: 1,
          reviewResult: {
            verdict: 'NG',
            summary: '警告のみ',
            findings: [
              { file: 'src/a.ts', severity: 'warning', message: '命名規則違反' },
            ],
          },
          timestamp: new Date(),
        }],
        lastReviewResult: {
          verdict: 'NG',
          summary: '警告のみ',
          findings: [
            { file: 'src/a.ts', severity: 'warning', message: '命名規則違反' },
          ],
        },
        warnings: [
          { file: 'src/a.ts', severity: 'warning', message: '命名規則違反' },
        ],
      };

      const retryCtx = buildRetryContext(warningOnlyResult);
      expect(retryCtx.errorFindings).toBeUndefined();
      expect(retryCtx.reviewSummary).toBe('警告のみ');
    });
  });

  // -------------------------------------------------------------------------
  // トークン量ガード: 巨大 diff stat の切り詰め
  // -------------------------------------------------------------------------

  describe('巨大 diff stat のトークン量ガード', () => {

    it('文字数上限を超える diff stat がサマリ行のみに切り詰められる', () => {
      // MAX_DIFF_STAT_LENGTH を超える巨大 diff stat を生成
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(` src/very/long/path/to/file-${i.toString().padStart(3, '0')}.ts | 100 ++++++`);
      }
      lines.push(' 200 files changed, 20000 insertions(+)');
      const hugeDiffStat = lines.join('\n');

      expect(hugeDiffStat.length).toBeGreaterThan(MAX_DIFF_STAT_LENGTH);

      const truncated = truncateDiffStat(hugeDiffStat);

      // サマリ行のみが残る
      expect(truncated).toContain('200 files changed, 20000 insertions(+)');
      expect(truncated).toContain('詳細省略');
      // 個別ファイル行は含まれない
      expect(truncated).not.toContain('src/very/long/path/to/file-000.ts');
    });

    it('行数上限を超える diff stat がサマリ行のみに切り詰められる', () => {
      // MAX_DIFF_STAT_LINES を超えるが文字数は短い diff stat
      const lines: string[] = [];
      for (let i = 0; i < MAX_DIFF_STAT_LINES + 10; i++) {
        lines.push(` f${i}.ts | 1 +`);
      }
      lines.push(` ${MAX_DIFF_STAT_LINES + 10} files changed`);
      const manyLinesDiffStat = lines.join('\n');

      // 行数が上限を超えている
      expect(manyLinesDiffStat.split('\n').length).toBeGreaterThan(MAX_DIFF_STAT_LINES);

      const truncated = truncateDiffStat(manyLinesDiffStat);

      // サマリ行のみが残る
      expect(truncated).toContain(`${MAX_DIFF_STAT_LINES + 10} files changed`);
      expect(truncated).toContain('詳細省略');
      // 個別ファイル行は含まれない
      expect(truncated).not.toContain('f0.ts');
    });

    it('巨大 diff stat がプロンプト経由でも切り詰められる', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        lines.push(` src/very/long/path/to/file-${i.toString().padStart(3, '0')}.ts | 100 ++++++`);
      }
      lines.push(' 200 files changed, 20000 insertions(+)');
      const hugeDiffStat = lines.join('\n');

      const mixedResult = createMixedReviewResult();

      const runAgent = vi.fn().mockResolvedValue(undefined);
      let callCount = 0;
      const runReviewLoop = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? mixedResult : defaultReviewLoopResult();
      });
      const execCommand = vi.fn().mockReturnValue(hugeDiffStat);

      const { ctx } = makeCtx({
        depsOverrides: { runAgent, runReviewLoop, execCommand },
      });

      // 1回目: レビューNG
      await handleImplementation(ctx);
      // 2回目: リトライ
      await handleImplementation(ctx);
      const retryPrompt = runAgent.mock.calls[1][0] as string;

      // プロンプトにサマリ行と切り詰めメッセージが含まれる
      expect(retryPrompt).toContain('200 files changed, 20000 insertions(+)');
      expect(retryPrompt).toContain('詳細省略');
      // 個別ファイル行はプロンプトに含まれない
      expect(retryPrompt).not.toContain('src/very/long/path/to/file-000.ts');
    });

    it('上限以内の diff stat はそのまま保持される', () => {
      const normalDiffStat = ' src/foo.ts | 10 +\n 1 file changed, 10 insertions(+)';
      const result = truncateDiffStat(normalDiffStat);
      expect(result).toBe(normalDiffStat);
      expect(result).not.toContain('省略');
    });

    it('閾値が定数として export されている', () => {
      expect(MAX_DIFF_STAT_LENGTH).toBe(2000);
      expect(MAX_DIFF_STAT_LINES).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // reviewResult 未保存時のフォールバック
  // -------------------------------------------------------------------------

  describe('reviewResult 未保存時のフォールバック', () => {

    it('retryContext が reason のみ（CI失敗等）の場合、追加セクションなしでプロンプトが生成される', async () => {
      const runAgent = vi.fn().mockResolvedValue(undefined);
      const { ctx } = makeCtx({ depsOverrides: { runAgent } });

      // CI 失敗等でレビュー結果がない retry
      ctx.setRetryContext({ reason: 'CI未通過: failure' });

      await handleImplementation(ctx);
      const prompt = runAgent.mock.calls[0][0] as string;

      // reason は含まれる
      expect(prompt).toContain('修正依頼');
      expect(prompt).toContain('CI未通過: failure');

      // レビュー文脈セクションは含まれない
      expect(prompt).not.toContain('前回の変更概要');
      expect(prompt).not.toContain('レビュー結果サマリ');
      expect(prompt).not.toContain('修正が必要なエラー');
    });

    it('Pipeline 経由の retry で step が retryContext をセットしなかった場合、reason のみの fallback が設定される', async () => {
      // handleImplementation を使わず、Pipeline の retry fallback を検証
      const stepHandler = vi.fn().mockResolvedValue({
        kind: 'retry',
        from: 'test-step',
        reason: 'テスト失敗',
      } as FlowSignal);

      const continueHandler = vi.fn().mockResolvedValue({
        kind: 'continue',
      } as FlowSignal);

      const pipeline = createPipeline<TaskContext>([
        step('test-step', stepHandler),
        step('next-step', continueHandler),
      ], { maxRetries: 3 });

      const { ctx } = makeCtx();

      // step が retryContext を設定しないまま retry signal を返す
      // 2回目は continue で終了
      stepHandler.mockResolvedValueOnce({
        kind: 'retry',
        from: 'test-step',
        reason: 'テスト失敗',
      }).mockResolvedValueOnce({ kind: 'continue' });

      await pipeline(ctx);

      // Pipeline が fallback で reason のみの retryContext を設定している
      const retryCtx = ctx.getRetryContext();
      expect(retryCtx).toBeDefined();
      expect(retryCtx!.reason).toBe('テスト失敗');
      // レビュー文脈は含まれない
      expect(retryCtx!.diffStat).toBeUndefined();
      expect(retryCtx!.reviewSummary).toBeUndefined();
      expect(retryCtx!.errorFindings).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // E2E: Pipeline 経由の handleImplementation retry サイクル
  // -------------------------------------------------------------------------

  describe('Pipeline 経由の retry サイクル', () => {

    it('レビューNG → retry → 2回目で OK になるフローで retryContext が正しく引き継がれる', async () => {
      const mixedResult = createMixedReviewResult();
      const diffStatOutput = ' src/handler.ts | 42 +++\n 1 file changed';

      const runAgent = vi.fn().mockResolvedValue(undefined);
      let reviewCallCount = 0;
      const runReviewLoop = vi.fn().mockImplementation(() => {
        reviewCallCount++;
        return reviewCallCount === 1 ? mixedResult : defaultReviewLoopResult();
      });
      const execCommand = vi.fn().mockReturnValue(diffStatOutput);

      const notifier = new FakeNotifier();
      const deps = createFakeDeps({ runAgent, runReviewLoop, execCommand });

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

      // implementation step のみの Pipeline を構築
      const pipeline = createPipeline<TaskContext>([
        step('implementation', handleImplementation),
      ], { maxRetries: 5 });

      const result = await pipeline(ctx);

      // Pipeline は完了する（2回目で OK）
      expect(result).toBe('done');

      // runAgent は 2 回呼ばれる
      expect(runAgent).toHaveBeenCalledTimes(2);

      // 1回目: 初回プロンプト
      const firstPrompt = runAgent.mock.calls[0][0] as string;
      expect(firstPrompt).toContain('実装してください');
      expect(firstPrompt).not.toContain('修正依頼');

      // 2回目: retryContext 付きプロンプト
      const retryPrompt = runAgent.mock.calls[1][0] as string;
      expect(retryPrompt).toContain('修正依頼');
      expect(retryPrompt).toContain('セルフレビュー未通過');
      expect(retryPrompt).toContain('前回の変更概要');
      expect(retryPrompt).toContain('src/handler.ts | 42 +++');
      expect(retryPrompt).toContain('レビュー結果サマリ');
      expect(retryPrompt).toContain('テストカバレッジ不足と命名に問題があります');
      expect(retryPrompt).toContain('修正が必要なエラー');
      expect(retryPrompt).toContain('未処理の例外があります');

      // WARNING はプロンプトに含まれない
      expect(retryPrompt).not.toContain('変数名が不適切です');
    });
  });

  // -------------------------------------------------------------------------
  // formatErrorFindings ヘルパーの統合検証
  // -------------------------------------------------------------------------

  describe('formatErrorFindings の出力形式', () => {

    it('ファイル・行番号・メッセージが正しくフォーマットされる', () => {
      const findings: ReviewFinding[] = [
        { file: 'src/handler.ts', line: 42, severity: 'error', message: '未処理の例外' },
        { file: 'src/utils.ts', severity: 'error', message: 'null チェック不足' },
        { severity: 'error', message: '全般的なエラー' },
      ];

      const formatted = formatErrorFindings(findings);

      expect(formatted).toContain('- **src/handler.ts:42**: 未処理の例外');
      expect(formatted).toContain('- **src/utils.ts**: null チェック不足');
      expect(formatted).toContain('- **(ファイル不明)**: 全般的なエラー');
    });
  });

  // -------------------------------------------------------------------------
  // diffStat 取得失敗時の耐障害性
  // -------------------------------------------------------------------------

  describe('diffStat 取得失敗時の耐障害性', () => {

    it('diffStat 取得に失敗しても retry は継続する', async () => {
      const mixedResult = createMixedReviewResult();

      const runAgent = vi.fn().mockResolvedValue(undefined);
      let reviewCallCount = 0;
      const runReviewLoop = vi.fn().mockImplementation(() => {
        reviewCallCount++;
        return reviewCallCount === 1 ? mixedResult : defaultReviewLoopResult();
      });
      // git diff --stat が失敗
      const execCommand = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('--stat')) throw new Error('git diff failed');
        return '';
      });

      const { ctx } = makeCtx({
        depsOverrides: { runAgent, runReviewLoop, execCommand },
      });

      // 1回目: レビューNG
      const signal = await handleImplementation(ctx);
      expect(signal.kind).toBe('retry');

      // retryContext は diffStat なしで設定されている
      const retryCtx = ctx.getRetryContext();
      expect(retryCtx).toBeDefined();
      expect(retryCtx!.reason).toBe('セルフレビュー未通過');
      expect(retryCtx!.diffStat).toBeUndefined();
      expect(retryCtx!.reviewSummary).toBeDefined();

      // 2回目: diffStat セクションなしのプロンプト
      await handleImplementation(ctx);
      const retryPrompt = runAgent.mock.calls[1][0] as string;
      expect(retryPrompt).not.toContain('前回の変更概要');
      expect(retryPrompt).toContain('レビュー結果サマリ');
    });
  });
});
