/**
 * マージフロー全体の E2E テスト
 *
 * マージ承認→マージ実行→ステータス更新の一連のフローを結合テストでカバーし、
 * 今後の回帰を防止する。
 *
 * シナリオ:
 * 1. マージ成功フロー: 承認→マージボタン押下→API成功→ステータス「merged」表示→一覧画面での反映
 * 2. マージ失敗フロー: 条件未充足エラー / 権限不足エラー / ネットワークエラー
 * 3. 二重クリック防止: マージ処理中に再度ボタン押下してもリクエストが重複送信されない
 * 4. マージブロック→差し戻しフロー
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps, defaultReviewLoopResult, defaultCIPollingResult } from '../helpers/fake-deps';
import { runStory, runTask } from '../../runner';
import { readStoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';
import { MergeError } from '../../merge/types';

// detectNoRemote をモック化（テスト環境では remote なしと判定されるため）
vi.mock('../../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git')>();
  return {
    ...actual,
    detectNoRemote: vi.fn().mockReturnValue(false),
  };
});

// ---------------------------------------------------------------------------
// Helper: fake vault のタスクディレクトリから TaskFile[] を読み取る
// ---------------------------------------------------------------------------
async function readTasksFromVault(
  tasksDir: string,
  project: string,
  storySlug: string,
): Promise<TaskFile[]> {
  const files = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(tasksDir, f))
    : [];
  const tasks: TaskFile[] = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const data = { ...parsed.data };
    tasks.push({
      filePath,
      project,
      storySlug,
      slug: path.basename(filePath, '.md'),
      status: (data.status as TaskStatus) ?? 'Todo',
      frontmatter: data,
      content: parsed.content,
    });
  }
  return tasks.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Helper: frontmatter を読み取る
// ---------------------------------------------------------------------------
function readFrontmatter(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { ...matter(raw).data };
}

// ---------------------------------------------------------------------------
// Helper: 結合テスト用の deps を生成する
// ---------------------------------------------------------------------------
function createIntegrationDeps(
  vault: FakeVaultResult,
  overrides?: Partial<RunnerDeps>,
): RunnerDeps {
  const { tasksDir } = vault;

  const integrationOverrides: Partial<RunnerDeps> = {
    getStoryTasks: vi.fn().mockImplementation(
      async (proj: string, slug: string) => readTasksFromVault(tasksDir, proj, slug),
    ),
    updateFileStatus: vi.fn().mockImplementation(
      (filePath: string, status: TaskStatus) => updateFileStatus(filePath, status),
    ),
    createTaskFile: vi.fn(),
    execCommand: vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr create') || cmd.includes('gh pr view')) {
        return 'https://github.com/test/repo/pull/1';
      }
      return '';
    }),
  };

  const merged = overrides
    ? { ...integrationOverrides, ...overrides }
    : integrationOverrides;

  return createFakeDeps(merged);
}

// ---------------------------------------------------------------------------
// Helper: テスト用 vault を作成し、テスト完了後にクリーンアップする
// ---------------------------------------------------------------------------
function withVault(
  fn: (vault: FakeVaultResult) => Promise<void>,
  options: Parameters<typeof createFakeVault>[0],
): () => Promise<void> {
  return async () => {
    matter.clearCache();
    const vault = createFakeVault(options);
    try {
      await fn(vault);
    } finally {
      vault.cleanup();
    }
  };
}

// ===========================================================================
// マージフロー E2E テスト
// ===========================================================================
describe('マージフロー E2E テスト', () => {
  const PROJECT = 'merge-test-project';
  const STORY_SLUG = 'merge-test-story';
  const TASK_SLUG = `${STORY_SLUG}-01-task`;
  const PR_URL = 'https://github.com/test/repo/pull/1';

  // =========================================================================
  // 1. マージ成功フロー
  // =========================================================================
  describe('マージ成功フロー', () => {
    it(
      '承認→マージ実行→ステータス「merged」表示→タスク Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // start approve → merge approve
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
          { action: 'approve' }, // マージ実行承認
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // --- マージAPIリクエストが正しく送信されたこと ---
        const execGhCalls = (deps.execGh as ReturnType<typeof vi.fn>).mock.calls;
        const mergeCalls = execGhCalls.filter(
          (call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[]).includes('merge'),
        );
        expect(mergeCalls.length).toBeGreaterThanOrEqual(1);

        // マージコマンドが --squash --delete-branch 付きで呼ばれたこと
        const mergeArgs = mergeCalls[0][0] as string[];
        expect(mergeArgs).toContain('--squash');
        expect(mergeArgs).toContain('--delete-branch');

        // --- マージ完了通知が送信されたこと ---
        const mergeCompletedNotification = notifier.notifications.find((n) =>
          n.message.includes('マージ完了'),
        );
        expect(mergeCompletedNotification).toBeDefined();

        // --- ステータス「merged」が通知に含まれること ---
        expect(mergeCompletedNotification!.message).toContain('merged');

        // --- PR URL が通知に含まれること ---
        expect(mergeCompletedNotification!.message).toContain(PR_URL);

        // --- タスクが Done になっていること ---
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');

        // --- ストーリーが Done になっていること ---
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'マージ処理中にローディング通知が表示されること',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
          { action: 'approve' }, // merge
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // マージ処理中通知が送信されていること
        const loadingNotification = notifier.notifications.find((n) =>
          n.message.includes('マージ処理中'),
        );
        expect(loadingNotification).toBeDefined();
        expect(loadingNotification!.message).toContain(TASK_SLUG);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'マージ承認メッセージにマージ条件一覧が含まれること',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
          { action: 'approve' }, // merge
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // マージ承認リクエストを取得
        const mergeApproval = notifier.approvalRequests.find((a) =>
          a.message.includes('マージ'),
        );
        expect(mergeApproval).toBeDefined();

        // マージ条件が表示されていること
        expect(mergeApproval!.message).toContain('マージ条件');
        expect(mergeApproval!.message).toContain('セルフレビュー通過');
        expect(mergeApproval!.message).toContain('CI通過');

        // ボタンラベルが「マージ実行」であること
        expect(mergeApproval!.buttons.approve).toBe('マージ実行');
        expect(mergeApproval!.buttons.reject).toBe('差し戻し');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'マージ成功後、通知イベントの順序が正しいこと',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
          { action: 'approve' }, // merge
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const events = notifier.events;

        // 1. タスク開始承認
        expect(events[0].type).toBe('requestApproval');
        expect((events[0] as { message: string }).message).toContain('タスク開始確認');

        // セルフレビュー結果通知 → マージ承認 → マージ処理中 → マージ完了の順序を検証
        const eventMessages = events.map((e) => {
          if (e.type === 'notify') return (e as { message: string }).message;
          if (e.type === 'requestApproval') return (e as { message: string }).message;
          return '';
        });

        const reviewIdx = eventMessages.findIndex((m) => m.includes('セルフレビュー結果'));
        const mergeApprovalIdx = eventMessages.findIndex((m) => m.includes('マージ実行依頼'));
        const loadingIdx = eventMessages.findIndex((m) => m.includes('マージ処理中'));
        const completedIdx = eventMessages.findIndex((m) => m.includes('マージ完了'));

        expect(reviewIdx).toBeGreaterThan(-1);
        expect(mergeApprovalIdx).toBeGreaterThan(reviewIdx);
        expect(loadingIdx).toBeGreaterThan(mergeApprovalIdx);
        expect(completedIdx).toBeGreaterThan(loadingIdx);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 2. マージ失敗フロー
  // =========================================================================
  describe('マージ失敗フロー', () => {

    // -----------------------------------------------------------------------
    // 2a. 条件未充足時のエラーメッセージ表示
    // -----------------------------------------------------------------------
    describe('条件未充足時', () => {
      it(
        'CI未通過時に通知が送信される',
        withVault(async (vault) => {
          const notifier = new FakeNotifier();
          // start approve → CIポーリング失敗→retry → 再実行後のマージ承認
          notifier.enqueueApprovalResponse(
            { action: 'approve' }, // タスク開始承認
            { action: 'approve' }, // 再実行後のマージ承認
          );

          // CIポーリングが1回目は失敗、2回目以降は成功
          const deps = createIntegrationDeps(vault, {
            runCIPollingLoop: vi.fn()
              .mockResolvedValueOnce({
                finalStatus: 'failure' as const,
                attempts: 1,
                attemptResults: [
                  { attempt: 1, ciResult: { status: 'failure', summary: 'CI failed' }, timestamp: new Date() },
                ],
                lastCIResult: { status: 'failure', summary: 'CI failed' },
              })
              .mockResolvedValue(defaultCIPollingResult()),
          });

          const story = readStoryFile(vault.storyFilePath);
          await runStory(story, notifier, deps);

          // CI未通過通知が送信されたこと
          const ciNotification = notifier.notifications.find((n) =>
            n.message.includes('CI未通過'),
          );
          expect(ciNotification).toBeDefined();

          // タスクスラッグがメッセージに含まれること
          expect(ciNotification!.message).toContain(TASK_SLUG);
        }, {
          project: PROJECT,
          story: { slug: STORY_SLUG, status: 'Doing' },
          tasks: [
            { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
          ],
        }),
      );

      it(
        'コンフリクト発生時にマージ失敗メッセージが表示される',
        withVault(async (vault) => {
          const notifier = new FakeNotifier();
          // start → 1st merge approve (fails: CONFLICTING) → 2nd merge approve (succeeds)
          notifier.enqueueApprovalResponse(
            { action: 'approve' }, // タスク開始承認
            { action: 'approve' }, // マージ承認（1回目・コンフリクトで失敗）
            { action: 'approve' }, // マージ承認（2回目・成功）
          );

          let viewCallCount = 0;
          const deps = createIntegrationDeps(vault, {
            execGh: vi.fn().mockImplementation((args: string[]) => {
              if (args.includes('view') && args.includes('--json')) {
                viewCallCount++;
                if (viewCallCount <= 1) {
                  return JSON.stringify({
                    state: 'OPEN',
                    mergeable: 'CONFLICTING',
                    reviewDecision: 'APPROVED',
                    statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
                  });
                }
                return JSON.stringify({
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  reviewDecision: 'APPROVED',
                  statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
                });
              }
              if (args.includes('merge')) {
                return '';
              }
              return PR_URL;
            }),
          });

          const story = readStoryFile(vault.storyFilePath);
          await runStory(story, notifier, deps);

          // マージ失敗通知が送信されたこと
          const failureNotification = notifier.notifications.find((n) =>
            n.message.includes('マージ失敗'),
          );
          expect(failureNotification).toBeDefined();
          expect(failureNotification!.message).toContain('merge_conflict');
        }, {
          project: PROJECT,
          story: { slug: STORY_SLUG, status: 'Doing' },
          tasks: [
            { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
          ],
        }),
      );
    });

    // -----------------------------------------------------------------------
    // 2b. 権限不足時のエラーメッセージ表示 (403)
    // -----------------------------------------------------------------------
    it(
      '権限不足（403）でマージ失敗時にエラーメッセージが表示される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // start → 1st merge approve (fails: permission denied) → 2nd merge approve (succeeds)
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
          { action: 'approve' }, // マージ実行承認（1回目・失敗）
          { action: 'approve' }, // マージ実行承認（2回目・成功）
        );

        let mergeAttempt = 0;
        const deps = createIntegrationDeps(vault, {
          execGh: vi.fn().mockImplementation((args: string[]) => {
            if (args.includes('view') && args.includes('--json')) {
              return JSON.stringify({
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                statusCheckRollup: [
                  { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
              });
            }
            if (args.includes('merge')) {
              mergeAttempt++;
              if (mergeAttempt === 1) {
                throw new Error('permission denied: You do not have permission to merge this PR');
              }
              return '';
            }
            return PR_URL;
          }),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // マージ失敗通知が送信されたこと
        const failureNotification = notifier.notifications.find((n) =>
          n.message.includes('マージ失敗'),
        );
        expect(failureNotification).toBeDefined();

        // エラーコードが含まれること
        expect(failureNotification!.message).toContain('permission_denied');

        // 権限に関するメッセージが含まれること
        expect(failureNotification!.message).toContain('マージ権限');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    // -----------------------------------------------------------------------
    // 2c. ネットワークエラー時のフォールバック表示
    // -----------------------------------------------------------------------
    it(
      'ネットワークエラーでマージ失敗時にエラーメッセージが表示される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // start → 1st merge approve (fails: network error) → 2nd merge approve (succeeds)
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
          { action: 'approve' }, // マージ実行承認（1回目・失敗）
          { action: 'approve' }, // マージ実行承認（2回目・成功）
        );

        let mergeCallCount = 0;
        const deps = createIntegrationDeps(vault, {
          execGh: vi.fn().mockImplementation((args: string[]) => {
            if (args.includes('view') && args.includes('--json')) {
              return JSON.stringify({
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                statusCheckRollup: [
                  { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
              });
            }
            if (args.includes('merge')) {
              mergeCallCount++;
              if (mergeCallCount === 1) {
                throw new Error('network error: connection timeout');
              }
              return '';
            }
            return PR_URL;
          }),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // マージ失敗通知が送信されたこと
        const failureNotification = notifier.notifications.find((n) =>
          n.message.includes('マージ失敗'),
        );
        expect(failureNotification).toBeDefined();
        expect(failureNotification!.message).toContain(PR_URL);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    // -----------------------------------------------------------------------
    // 2d. マージ実行時のバリデーションエラー
    // -----------------------------------------------------------------------
    it(
      'マージ実行時にバリデーション失敗（承認不足）すると構造化エラーが表示される',
      withVault(async (vault) => {
        let viewCallCount = 0;
        const notifier = new FakeNotifier();
        // start → 1st merge approve (executeMerge内バリデーション失敗) → 2nd merge approve (成功)
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
          { action: 'approve' }, // マージ実行承認（1回目・バリデーション失敗）
          { action: 'approve' }, // マージ実行承認（2回目・成功）
        );

        // 1回目の pr view (executeMerge内バリデーション) は承認不足、2回目以降はOK
        const deps = createIntegrationDeps(vault, {
          execGh: vi.fn().mockImplementation((args: string[]) => {
            if (args.includes('view') && args.includes('--json')) {
              viewCallCount++;
              if (viewCallCount <= 1) {
                // 1回目: 承認が不足している状態
                return JSON.stringify({
                  state: 'OPEN',
                  mergeable: 'MERGEABLE',
                  reviewDecision: 'REVIEW_REQUIRED',
                  statusCheckRollup: [
                    { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
                  ],
                });
              }
              // 2回目以降: 承認済み
              return JSON.stringify({
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                statusCheckRollup: [
                  { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
              });
            }
            if (args.includes('merge')) {
              return '';
            }
            return PR_URL;
          }),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // マージ失敗通知が送信されたこと
        const failureNotification = notifier.notifications.find((n) =>
          n.message.includes('マージ失敗'),
        );
        expect(failureNotification).toBeDefined();
        expect(failureNotification!.message).toContain('insufficient_approvals');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 3. 二重クリック防止
  // =========================================================================
  describe('二重クリック防止', () => {
    it(
      'マージ処理中は execGh merge が 1 回だけ呼ばれること',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
          { action: 'approve' }, // merge
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // execGh の merge 呼び出し回数を検証
        const execGhCalls = (deps.execGh as ReturnType<typeof vi.fn>).mock.calls;
        const mergeCalls = execGhCalls.filter(
          (call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[]).includes('merge'),
        );

        // merge コマンドは正確に 1 回だけ呼ばれること（二重実行されていない）
        expect(mergeCalls).toHaveLength(1);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'マージ承認リクエストは 1 回だけ発行されること',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
          { action: 'approve' }, // merge
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // マージ承認リクエストの回数を検証
        const mergeApprovals = notifier.approvalRequests.filter((a) =>
          a.message.includes('マージ'),
        );
        expect(mergeApprovals).toHaveLength(1);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 4. マージ差し戻しフロー
  // =========================================================================
  describe('マージ差し戻しフロー', () => {
    it(
      'マージ承認で差し戻しを選択するとやり直しループに入る',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                              // タスク開始承認
          { action: 'reject', reason: 'テストカバレッジ不足' }, // マージ差し戻し（1回目）
          { action: 'approve' },                              // マージ承認（2回目）
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // runAgent が 2 回呼ばれたこと（初回 + やり直し）
        expect(deps.runAgent).toHaveBeenCalledTimes(2);

        // 2 回目の runAgent プロンプトに差し戻し理由が含まれること
        const secondCallArgs = (deps.runAgent as ReturnType<typeof vi.fn>).mock.calls[1];
        expect(secondCallArgs[0]).toContain('テストカバレッジ不足');

        // 最終的にタスクが Done になること
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'マージブロック時に差し戻しを選択するとやり直しループに入る',
      withVault(async (vault) => {
        let execGhCallCount = 0;
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                                   // タスク開始承認
          { action: 'reject', reason: 'コンフリクトを解消して' },     // マージブロック→差し戻し
          { action: 'approve' },                                   // 2回目マージ承認
        );

        // 1回目はコンフリクト、2回目はクリーン
        const deps = createIntegrationDeps(vault, {
          execGh: vi.fn().mockImplementation((args: string[]) => {
            if (args.includes('view') && args.includes('--json')) {
              execGhCallCount++;
              if (execGhCallCount <= 2) {
                // 1回目: コンフリクト状態
                return JSON.stringify({
                  state: 'OPEN',
                  mergeable: 'CONFLICTING',
                  reviewDecision: 'APPROVED',
                  statusCheckRollup: [
                    { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
                  ],
                });
              }
              // 2回目以降: クリーン状態
              return JSON.stringify({
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                statusCheckRollup: [
                  { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
              });
            }
            if (args.includes('merge')) {
              return '';
            }
            return PR_URL;
          }),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // runAgent が 2 回呼ばれたこと（初回 + やり直し）
        expect(deps.runAgent).toHaveBeenCalledTimes(2);

        // 差し戻し理由がプロンプトに含まれること
        const secondCallArgs = (deps.runAgent as ReturnType<typeof vi.fn>).mock.calls[1];
        expect(secondCallArgs[0]).toContain('コンフリクトを解消して');

        // 最終的にタスクが Done になること
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 5. マージ失敗後のリトライフロー
  // =========================================================================
  describe('マージ失敗後のリトライフロー', () => {
    it(
      'マージ失敗後にタスク完了確認でやり直しを選択すると再実行される',
      withVault(async (vault) => {
        let mergeAttempt = 0;
        const notifier = new FakeNotifier();
        notifier.enqueueApprovalResponse(
          { action: 'approve' },                               // タスク開始承認
          { action: 'approve' },                               // マージ承認（1回目・失敗する）
          { action: 'reject', reason: 'マージエラーを修正して' }, // タスク完了→やり直し
          { action: 'approve' },                               // マージ承認（2回目・成功する）
        );

        const deps = createIntegrationDeps(vault, {
          execGh: vi.fn().mockImplementation((args: string[]) => {
            if (args.includes('view') && args.includes('--json')) {
              return JSON.stringify({
                state: 'OPEN',
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                statusCheckRollup: [
                  { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
              });
            }
            if (args.includes('merge')) {
              mergeAttempt++;
              if (mergeAttempt === 1) {
                throw new Error('merge conflict detected');
              }
              return '';  // 2回目は成功
            }
            return PR_URL;
          }),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // マージが 2 回試行されたこと
        expect(mergeAttempt).toBe(2);

        // マージ失敗通知 → マージ完了通知の順序
        const failureIdx = notifier.notifications.findIndex((n) =>
          n.message.includes('マージ失敗'),
        );
        const successIdx = notifier.notifications.findIndex((n) =>
          n.message.includes('マージ完了'),
        );
        expect(failureIdx).toBeGreaterThan(-1);
        expect(successIdx).toBeGreaterThan(failureIdx);

        // 最終的にタスクが Done
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // =========================================================================
  // 6. 複数タスクのマージフロー
  // =========================================================================
  describe('複数タスクのマージフロー', () => {
    it(
      '複数タスクそれぞれでマージが実行されること',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 2 タスク × (start + merge) = 4 approvals
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // task1 start
          { action: 'approve' }, // task1 merge
          { action: 'approve' }, // task2 start
          { action: 'approve' }, // task2 merge
        );

        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // execGh の merge 呼び出し回数を検証（タスクごとに 1 回 = 2 回）
        const execGhCalls = (deps.execGh as ReturnType<typeof vi.fn>).mock.calls;
        const mergeCalls = execGhCalls.filter(
          (call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[]).includes('merge'),
        );
        expect(mergeCalls).toHaveLength(2);

        // マージ完了通知が 2 回送信されること
        const mergeCompletedNotifications = notifier.notifications.filter((n) =>
          n.message.includes('マージ完了'),
        );
        expect(mergeCompletedNotifications).toHaveLength(2);

        // 両タスクが Done
        for (const taskPath of vault.taskFilePaths) {
          expect(readFrontmatter(taskPath).status).toBe('Done');
        }

        // ストーリーが Done
        expect(readFrontmatter(vault.storyFilePath).status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-first`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-second`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );
  });

  // =========================================================================
  // 7. マージスキップフロー（CI 失敗時）
  // =========================================================================
  describe('マージスキップフロー', () => {
    it(
      'CI 失敗時は CI未通過通知が送信され、実装が再試行される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // start → CI失敗→retry → 再試行後のマージ承認
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
          { action: 'approve' }, // 再試行後のマージ承認
        );

        const deps = createIntegrationDeps(vault, {
          runCIPollingLoop: vi.fn()
            .mockResolvedValueOnce({
              finalStatus: 'failure' as const,
              attempts: 3,
              attemptResults: [
                { attempt: 1, ciResult: { status: 'failure', summary: 'Tests failed' }, timestamp: new Date() },
              ],
              lastCIResult: { status: 'failure', summary: 'Tests failed' },
            })
            .mockResolvedValue(defaultCIPollingResult()),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // CI未通過通知が送信されたこと
        const ciNotification = notifier.notifications.find((n) =>
          n.message.includes('CI未通過'),
        );
        expect(ciNotification).toBeDefined();

        // 実装が再試行されたこと（runAgent が2回呼ばれた）
        expect(deps.runAgent).toHaveBeenCalledTimes(2);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'セルフレビュー NG 時はエスカレーション通知が送信され、実装が再試行される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // start → レビューNG（エスカレーション）→retry → 再試行後のマージ承認
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // タスク開始承認
          { action: 'approve' }, // 再試行後のマージ承認
        );

        const ngResult = {
          finalVerdict: 'NG' as const,
          escalationRequired: true,
          iterations: [
            {
              iteration: 1,
              reviewResult: {
                verdict: 'NG' as const,
                summary: 'Critical issues found',
                findings: [{ severity: 'error' as const, message: 'Missing null check', file: 'src/main.ts', line: 42 }],
              },
              timestamp: new Date(),
            },
          ],
          lastReviewResult: {
            verdict: 'NG' as const,
            summary: 'Critical issues found',
            findings: [{ severity: 'error' as const, message: 'Missing null check', file: 'src/main.ts', line: 42 }],
          },
        };

        const deps = createIntegrationDeps(vault, {
          runReviewLoop: vi.fn()
            .mockResolvedValueOnce(ngResult)
            .mockResolvedValue(defaultReviewLoopResult()),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // エスカレーション通知が送信されたこと
        const escalationNotification = notifier.notifications.find((n) =>
          n.message.includes('エスカレーション'),
        );
        expect(escalationNotification).toBeDefined();

        // 実装が再試行されたこと（runAgent が2回呼ばれた）
        expect(deps.runAgent).toHaveBeenCalledTimes(2);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: TASK_SLUG, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });
});
