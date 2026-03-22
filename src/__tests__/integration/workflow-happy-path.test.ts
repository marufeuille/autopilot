import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { createFakeVault, FakeVaultResult } from '../helpers/fake-vault';
import { FakeNotifier } from '../helpers/fake-notifier';
import { createFakeDeps } from '../helpers/fake-deps';
import { runStory } from '../../runner';
import { readStoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { updateFileStatus, TaskDraft } from '../../vault/writer';
import { RunnerDeps } from '../../runner-deps';

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
    // gray-matter はコンテンツ文字列でパース結果をキャッシュする。
    // updateFileStatus がキャッシュ内の data オブジェクトを直接変更するため、
    // 同一コンテンツの後続パースで古い値を返す可能性がある。
    // data をクローンして使用する。
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
// Helper: fake vault にタスクファイルを作成する
// ---------------------------------------------------------------------------
function createTaskFileInVault(
  tasksDir: string,
  _project: string,
  storySlug: string,
  draft: TaskDraft,
): void {
  const filePath = path.join(tasksDir, `${draft.slug}.md`);
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter: Record<string, unknown> = {
    status: 'Todo',
    priority: draft.priority,
    effort: draft.effort,
    story: storySlug,
    due: null,
    project: _project,
    created: today,
    finished_at: null,
    pr: null,
  };
  const criteriaList = draft.criteria.map((c) => `- [ ] ${c}`).join('\n');
  const content = `\n# ${draft.title}\n\n## 目的\n\n${draft.purpose}\n\n## 詳細\n\n${draft.detail}\n\n## 完了条件\n\n${criteriaList}\n\n## メモ\n\n`;
  fs.writeFileSync(filePath, matter.stringify(content, frontmatter));
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
//   - getStoryTasks / updateFileStatus / createTaskFile は実ファイル I/O
//   - runAgent, execGh, execCommand 等はフェイク
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
    createTaskFile: vi.fn().mockImplementation(
      (proj: string, slug: string, draft: TaskDraft) =>
        createTaskFileInVault(tasksDir, proj, slug, draft),
    ),
    // gh pr create / gh pr view で PR URL を返す
    execCommand: vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr create') || cmd.includes('gh pr view')) {
        return 'https://github.com/test/repo/pull/1';
      }
      return '';
    }),
  };

  // overrides がある場合は統合
  const merged = overrides
    ? { ...integrationOverrides, ...overrides }
    : integrationOverrides;

  return createFakeDeps(merged);
}

// ---------------------------------------------------------------------------
// テスト用タスクドラフト
// ---------------------------------------------------------------------------
function sampleTaskDrafts(storySlug: string): TaskDraft[] {
  return [
    {
      slug: `${storySlug}-01-setup`,
      title: 'セットアップ',
      priority: 'high',
      effort: 'low',
      purpose: 'プロジェクトの初期設定',
      detail: '必要なファイルの作成',
      criteria: ['設定ファイルが存在する'],
    },
    {
      slug: `${storySlug}-02-implement`,
      title: '実装',
      priority: 'high',
      effort: 'medium',
      purpose: '機能の実装',
      detail: 'メイン機能のコーディング',
      criteria: ['テストが通る', 'ドキュメントが更新されている'],
    },
  ];
}

// ---------------------------------------------------------------------------
// Helper: テスト用 vault を作成し、テスト完了後にクリーンアップする
// ---------------------------------------------------------------------------
function withVault(
  fn: (vault: FakeVaultResult) => Promise<void>,
  options: Parameters<typeof createFakeVault>[0],
): () => Promise<void> {
  return async () => {
    // gray-matter はコンテンツ文字列でパース結果をキャッシュする。
    // updateFileStatus がキャッシュ内の data オブジェクトを直接変更するため、
    // テスト間でキャッシュをクリアして状態のリークを防ぐ。
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
// 正常系ワークフロー結合テスト
// ===========================================================================
describe('正常系ワークフロー結合テスト', () => {
  // -------------------------------------------------------------------------
  // テスト 1: ストーリーがタスク分解され全タスクが完了する
  // -------------------------------------------------------------------------
  describe('ストーリーがタスク分解され全タスクが完了する', () => {
    const PROJECT = 'test-project';
    const STORY_SLUG = 'test-story';

    it(
      'decomposeTasks → タスクファイル生成 → 全タスク Done → ストーリー Done',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const drafts = sampleTaskDrafts(STORY_SLUG);
        const deps = createIntegrationDeps(vault, {
          decomposeTasks: vi.fn().mockResolvedValue(drafts),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // --- decomposeTasks が 1 回呼ばれた ---
        expect(deps.decomposeTasks).toHaveBeenCalledTimes(1);

        // --- タスクファイルが生成された ---
        expect(deps.createTaskFile).toHaveBeenCalledTimes(2);
        const taskFiles = await readTasksFromVault(vault.tasksDir, PROJECT, STORY_SLUG);
        expect(taskFiles).toHaveLength(2);
        expect(taskFiles.map((t) => t.slug)).toEqual([
          `${STORY_SLUG}-01-setup`,
          `${STORY_SLUG}-02-implement`,
        ]);

        // --- 各タスクが Done ---
        for (const tf of taskFiles) {
          const fm = readFrontmatter(tf.filePath);
          expect(fm.status).toBe('Done');
        }

        // --- ストーリーが Done ---
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // --- ストーリー完了通知が送られた ---
        const completionNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(completionNotification).toBeDefined();
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [],
      }),
    );

    it(
      'タスク分解で生成された各タスクが Todo→Doing→Done と遷移する',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const drafts = sampleTaskDrafts(STORY_SLUG);

        // updateFileStatus の呼び出し順序を記録する
        const statusTransitions: Array<{ slug: string; status: string }> = [];
        const trackingUpdateFileStatus = (filePath: string, status: TaskStatus) => {
          updateFileStatus(filePath, status);
          const slug = path.basename(filePath, '.md');
          statusTransitions.push({ slug, status });
        };

        const deps = createIntegrationDeps(vault, {
          decomposeTasks: vi.fn().mockResolvedValue(drafts),
          updateFileStatus: vi.fn().mockImplementation(trackingUpdateFileStatus),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 各タスクが Doing → Done を経ている
        for (const draft of drafts) {
          const doingEntry = statusTransitions.find(
            (t) => t.slug === draft.slug && t.status === 'Doing',
          );
          const doneEntry = statusTransitions.find(
            (t) => t.slug === draft.slug && t.status === 'Done',
          );
          expect(doingEntry).toBeDefined();
          expect(doneEntry).toBeDefined();

          // Doing が Done より先に来ている
          const doingIdx = statusTransitions.indexOf(doingEntry!);
          const doneIdx = statusTransitions.indexOf(doneEntry!);
          expect(doingIdx).toBeLessThan(doneIdx);
        }
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // テスト 2: 既にタスクが存在するストーリーの実行
  // -------------------------------------------------------------------------
  describe('既にタスクが存在するストーリーの実行', () => {
    const PROJECT = 'existing-tasks-project';
    const STORY_SLUG = 'existing-story';

    it(
      'decomposeTasks が呼ばれず既存タスクが順次実行される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // --- decomposeTasks が呼ばれていない ---
        expect(deps.decomposeTasks).not.toHaveBeenCalled();
        expect(deps.createTaskFile).not.toHaveBeenCalled();

        // --- 既存のタスクが全て Done ---
        const taskFiles = await readTasksFromVault(vault.tasksDir, PROJECT, STORY_SLUG);
        expect(taskFiles).toHaveLength(2);
        for (const tf of taskFiles) {
          const fm = readFrontmatter(tf.filePath);
          expect(fm.status).toBe('Done');
        }

        // --- ストーリーが Done ---
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');

        // --- runAgent がタスク数分だけ呼ばれた ---
        expect(deps.runAgent).toHaveBeenCalledTimes(2);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-first`, status: 'Todo', priority: 'high' },
          { slug: `${STORY_SLUG}-02-second`, status: 'Todo', priority: 'medium' },
        ],
      }),
    );

    it(
      'Done / Skipped のタスクは実行されない',
      withVault(async (vault) => {
        // タスクの状態を変更: 1つ目は Done に
        const taskFiles = await readTasksFromVault(vault.tasksDir, PROJECT, STORY_SLUG);
        updateFileStatus(taskFiles[0].filePath, 'Done');

        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // runAgent は Todo のタスク (2つ目) だけ実行される
        expect(deps.runAgent).toHaveBeenCalledTimes(1);

        // 全タスクが Done
        const finalTasks = await readTasksFromVault(vault.tasksDir, PROJECT, STORY_SLUG);
        for (const tf of finalTasks) {
          const fm = readFrontmatter(tf.filePath);
          expect(fm.status).toBe('Done');
        }
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

  // -------------------------------------------------------------------------
  // テスト 3: 承認フローの検証
  //
  // 正常系（レビューOK + CI通過 + マージ承認）では、runTask のフローは:
  //   1. タスク開始承認 (requestApproval)
  //   2. agent実行 → レビュー → PR作成 → CI → マージ承認 (requestApproval)
  //   3. merge approve → break → Done
  // タスク完了承認は、マージがスキップされた場合のみ発行される。
  // -------------------------------------------------------------------------
  describe('承認フローの検証', () => {
    const PROJECT = 'approval-project';
    const STORY_SLUG = 'approval-story';

    it(
      'タスク開始前・マージ前に承認リクエストが発行される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 承認リクエストを検証
        const approvals = notifier.approvalRequests;

        // 正常系: start(1) + merge(2) = 2 回
        // (merge approve 後に break するためタスク完了承認はスキップ)
        expect(approvals.length).toBe(2);

        // 1. タスク開始承認
        expect(approvals[0].message).toContain('タスク開始確認');
        expect(approvals[0].message).toContain(`${STORY_SLUG}-01-task`);

        // 2. マージ承認（CI通過後）
        expect(approvals[1].message).toContain('マージ');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      '全ての承認が approve で返されるとフローが正常に完了する',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        // 明示的に全て approve を設定
        notifier.enqueueApprovalResponse(
          { action: 'approve' }, // start
          { action: 'approve' }, // merge
        );

        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 全ての承認リクエストが approve された
        for (const approval of notifier.approvalRequests) {
          expect(approval.response).toEqual({ action: 'approve' });
        }

        // タスクとストーリーが Done
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');

        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      'タスク分解時にも承認リクエストが発行される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const drafts: TaskDraft[] = [
          {
            slug: 'decompose-story-01-task',
            title: 'テストタスク',
            priority: 'high',
            effort: 'low',
            purpose: 'テスト用',
            detail: 'テスト詳細',
            criteria: ['完了条件'],
          },
        ];
        const deps = createIntegrationDeps(vault, {
          decomposeTasks: vi.fn().mockResolvedValue(drafts),
        });

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const approvals = notifier.approvalRequests;

        // 分解承認(1) + タスク開始(2) + マージ(3) = 3
        expect(approvals.length).toBe(3);

        // 最初の承認はタスク分解の承認
        expect(approvals[0].message).toContain('タスク分解案');

        // 2番目はタスク開始承認
        expect(approvals[1].message).toContain('タスク開始確認');

        // 3番目はマージ承認
        expect(approvals[2].message).toContain('マージ');
      }, {
        project: PROJECT,
        story: { slug: 'decompose-story', status: 'Doing' },
        tasks: [],
      }),
    );

    it(
      '承認リクエストの id が一貫した形式で生成される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const approvalIds = notifier.approvalRequests.map((a) => a.id);

        // 全ての id が空でないこと
        for (const id of approvalIds) {
          expect(id).toBeTruthy();
          expect(typeof id).toBe('string');
        }

        // id が全て異なること（重複がない）
        const uniqueIds = new Set(approvalIds);
        expect(uniqueIds.size).toBe(approvalIds.length);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // テスト 4: 通知の検証
  // -------------------------------------------------------------------------
  describe('通知の検証', () => {
    const PROJECT = 'notification-project';
    const STORY_SLUG = 'notification-story';

    it(
      'セルフレビュー結果とストーリー完了通知が送信される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // セルフレビュー結果通知
        const reviewNotification = notifier.notifications.find((n) =>
          n.message.includes('セルフレビュー結果'),
        );
        expect(reviewNotification).toBeDefined();

        // ストーリー完了通知
        const completionNotification = notifier.notifications.find((n) =>
          n.message.includes('ストーリー完了'),
        );
        expect(completionNotification).toBeDefined();
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );

    it(
      '通知とイベントの発行順序が正しい',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);

        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        const events = notifier.events;
        // 正常系: start approval + review notify + merge approval + completion notify = 4
        expect(events.length).toBeGreaterThanOrEqual(4);

        // 最初のイベントはタスク開始の承認リクエスト
        expect(events[0].type).toBe('requestApproval');
        expect((events[0] as { message: string }).message).toContain('タスク開始確認');

        // 最後のイベントはストーリー完了通知
        const lastEvent = events[events.length - 1];
        expect(lastEvent.type).toBe('notify');
        expect((lastEvent as { message: string }).message).toContain('ストーリー完了');
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-task`, status: 'Todo', priority: 'high' },
        ],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // テスト 5: Vault ファイルの frontmatter 最終状態の検証
  // -------------------------------------------------------------------------
  describe('Vault ファイルの frontmatter 最終状態の検証', () => {
    const PROJECT = 'frontmatter-project';
    const STORY_SLUG = 'frontmatter-story';

    it(
      '完了後のタスクファイルに正しい frontmatter フィールドが設定される',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // タスクの frontmatter を検証
        const taskFm = readFrontmatter(vault.taskFilePaths[0]);
        expect(taskFm.status).toBe('Done');
        expect(taskFm.project).toBe(PROJECT);
        expect(taskFm.story).toBe(STORY_SLUG);
        expect(taskFm.priority).toBe('high');
        expect(taskFm.effort).toBe('low');

        // ストーリーの frontmatter を検証
        const storyFm = readFrontmatter(vault.storyFilePath);
        expect(storyFm.status).toBe('Done');
        expect(storyFm.project).toBe(PROJECT);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          {
            slug: `${STORY_SLUG}-01-task`,
            status: 'Todo',
            priority: 'high',
            effort: 'low',
          },
        ],
      }),
    );

    it(
      '複数タスクが全て完了した際のストーリー frontmatter',
      withVault(async (vault) => {
        const notifier = new FakeNotifier();
        const deps = createIntegrationDeps(vault);
        const story = readStoryFile(vault.storyFilePath);
        await runStory(story, notifier, deps);

        // 全タスクが Done
        for (const taskPath of vault.taskFilePaths) {
          expect(readFrontmatter(taskPath).status).toBe('Done');
        }

        // ストーリーが Done
        expect(readFrontmatter(vault.storyFilePath).status).toBe('Done');

        // runAgent が 3 回呼ばれた
        expect(deps.runAgent).toHaveBeenCalledTimes(3);
      }, {
        project: PROJECT,
        story: { slug: STORY_SLUG, status: 'Doing' },
        tasks: [
          { slug: `${STORY_SLUG}-01-a`, status: 'Todo' },
          { slug: `${STORY_SLUG}-02-b`, status: 'Todo' },
          { slug: `${STORY_SLUG}-03-c`, status: 'Todo' },
        ],
      }),
    );
  });
});
