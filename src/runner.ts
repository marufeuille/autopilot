import { StoryFile, StoryStatus, TaskFile, TaskStatus } from './vault/reader';
import { TaskDraft } from './vault/writer';
import {
  NotificationBackend,
  generateApprovalId,
  buildThreadOriginMessage,
  buildReadmePRBlocks,
} from './notification';
import { detectNoRemote } from './git';
import { resolveRepoPath } from './config';
import { RunnerDeps, createDefaultRunnerDeps } from './runner-deps';
import { createTaskContext } from './pipeline/runner';
import { taskPipeline } from './pipeline/task-pipeline';
import { runStoryDocUpdate } from './story-doc-update';
import { runMergePollingLoop } from './merge';
import { createCommandLogger } from './logger';
import type { AcceptanceCheckResult as GateCheckResult } from './story-acceptance-gate';
import type { AcceptanceCheckResult as NotificationCheckResult } from './notification/types';

const log = createCommandLogger('runner');

export { RunnerDeps, createDefaultRunnerDeps } from './runner-deps';

/** Task失敗時のユーザー選択肢（型は notification/types.ts から再エクスポート） */
export type { TaskFailureAction } from './notification/types';

/**
 * Task失敗時にSlackのストーリースレッドへボタン付き通知を送信し、
 * ユーザーの選択（リトライ/スキップ/キャンセル）を待つ。
 *
 * NotificationBackend.requestTaskFailureAction に委譲する。
 */
export async function requestTaskFailureAction(
  task: TaskFile,
  story: StoryFile,
  notifier: NotificationBackend,
  error: unknown,
): Promise<import('./notification/types').TaskFailureAction> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return notifier.requestTaskFailureAction(task.slug, story.slug, errorMessage);
}

export async function runTask(
  task: TaskFile,
  story: StoryFile,
  notifier: NotificationBackend,
  repoPath: string,
  deps?: RunnerDeps,
): Promise<void> {
  const d = deps ?? createDefaultRunnerDeps();
  const ctx = createTaskContext({ task, story, repoPath, notifier, deps: d });

  try {
    const result = await taskPipeline(ctx);
    if (result === 'skipped') {
      d.updateFileStatus(task.filePath, 'Skipped');
    }
  } catch (error) {
    d.updateFileStatus(task.filePath, 'Failed');
    throw error;
  }
}

function formatDecompositionMessage(story: StoryFile, drafts: TaskDraft[]): string {
  const list = drafts
    .map((d, i) => `${i + 1}. *${d.title}* (\`${d.slug}\`)\n   ${d.purpose}`)
    .join('\n');
  return `*タスク分解案*\n\n*ストーリー*: ${story.slug}\n\n${list}\n\n承認するとタスクファイルを作成して実行を開始します。`;
}

/**
 * story-acceptance-gate の AcceptanceCheckResult を
 * notification/types の AcceptanceCheckResult にマッピングする。
 */
export function toNotificationCheckResult(gate: GateCheckResult): NotificationCheckResult {
  return {
    allPassed: gate.allPassed,
    conditions: gate.results.map((r) => ({
      condition: r.criterion,
      passed: r.result === 'PASS',
      reason: r.reason,
    })),
  };
}

function formatAdditionalTasksMessage(story: StoryFile, drafts: TaskDraft[]): string {
  const list = drafts
    .map((d, i) => `${i + 1}. *${d.title}* (\`${d.slug}\`)\n   ${d.purpose}`)
    .join('\n');
  return `*追加タスク案*\n\n*ストーリー*: ${story.slug}\n\n${list}\n\n承認するとタスクファイルを作成して実行を開始します。`;
}

/**
 * 受け入れ条件ゲートを実行する。
 *
 * 全タスクが Done/Skipped になった後に呼び出し、
 * ストーリーの受け入れ条件を Claude がチェックして結果を Slack に通知する。
 * ユーザーの選択に応じて Done / force_done / 追加タスク生成を行う。
 *
 * @returns 'done' — ストーリーを Done にする（通常 Done または force_done）
 * @returns 'continue' — 追加タスクが生成されたのでタスクループを再開する
 */
async function runAcceptanceGate(
  story: StoryFile,
  allTasks: TaskFile[],
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<{ result: 'done'; messageTs?: string } | { result: 'continue' }> {
  // 1. 受け入れ条件チェック
  log.info('checking acceptance criteria', { storySlug: story.slug, phase: 'acceptance_gate' });
  const checkResult = await deps.checkAcceptanceCriteria(story, allTasks, repoPath);

  // 2. 受け入れ条件セクションがない場合はスキップ
  if (checkResult.skipped) {
    log.warn('acceptance criteria skipped (no section)', { storySlug: story.slug, phase: 'acceptance_gate' });
    return { result: 'done' };
  }

  // 3. 結果を通知形式に変換してユーザーに提示
  const notificationResult = toNotificationCheckResult(checkResult);
  const gateAction = await notifier.requestAcceptanceGateAction(story.slug, notificationResult);

  // 4. ユーザーの選択に応じて処理
  if (gateAction.action === 'done') {
    log.info('acceptance gate: user approved Done', { storySlug: story.slug, phase: 'acceptance_gate' });
    return { result: 'done', messageTs: gateAction.messageTs };
  }

  if (gateAction.action === 'force_done') {
    log.info('acceptance gate: user force-done', { storySlug: story.slug, phase: 'acceptance_gate' });
    return { result: 'done', messageTs: gateAction.messageTs };
  }

  // 5. コメント入力 → 追加タスク生成
  const comment = gateAction.text;
  log.info('acceptance gate: user commented', { storySlug: story.slug, comment, phase: 'acceptance_gate' });

  const failedCriteria = checkResult.results.filter((r) => r.result === 'FAIL');
  const additionalDrafts = await deps.generateAdditionalTasks(story, allTasks, comment, failedCriteria);

  // 「追加タスク不要」と判断された場合
  if (additionalDrafts.length === 0) {
    log.info('acceptance gate: no additional tasks generated, marking done', { storySlug: story.slug, phase: 'acceptance_gate' });
    return { result: 'done' };
  }

  // 6. 追加タスク案の承認ゲート（タスク分解と同様）
  let retryReason: string | undefined;
  while (true) {
    const draftsToApprove = retryReason
      ? await deps.generateAdditionalTasks(story, allTasks, `${comment}\n\nやり直し理由: ${retryReason}`, failedCriteria)
      : additionalDrafts;

    if (draftsToApprove.length === 0) {
      log.info('acceptance gate: regeneration produced no tasks, marking done', { storySlug: story.slug, phase: 'acceptance_gate' });
      return { result: 'done' };
    }

    const id = generateApprovalId(story.slug, 'additional-tasks');
    const approvalResult = await notifier.requestApproval(
      id,
      formatAdditionalTasksMessage(story, draftsToApprove),
      { approve: '承認', reject: 'やり直し', cancel: 'キャンセル（Doneにする）' },
      story.slug,
    );

    if (approvalResult.action === 'approve') {
      for (const draft of draftsToApprove) {
        deps.createTaskFile(story.project, story.slug, draft);
        log.info('additional task file created', { taskSlug: draft.slug, phase: 'acceptance_gate' });
      }
      return { result: 'continue' };
    }

    if (approvalResult.action === 'cancel') {
      log.info('acceptance gate: additional tasks cancelled, marking done', { storySlug: story.slug, phase: 'acceptance_gate' });
      return { result: 'done' };
    }

    retryReason = approvalResult.reason;
    log.info('acceptance gate: additional tasks rejected, retrying', { retryReason, phase: 'acceptance_gate' });
  }
}

/**
 * Todo タスクを順番に実行し、失敗時のリトライ/スキップ/キャンセルを処理する。
 *
 * @returns 'completed' — 全タスク実行完了（Done/Skipped）
 * @returns 'cancelled' — ユーザーがキャンセルを選択
 */
async function runTodoTasks(
  todoTasks: TaskFile[],
  story: StoryFile,
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<'completed' | 'cancelled'> {
  let i = 0;
  while (i < todoTasks.length) {
    const task = todoTasks[i];
    let retryCount = 0;
    let succeeded = false;

    while (!succeeded) {
      try {
        await runTask(task, story, notifier, repoPath, deps);
        succeeded = true;
      } catch (error) {
        log.error('task failed', { taskSlug: task.slug, phase: 'task_execution' }, error);

        const action = await requestTaskFailureAction(task, story, notifier, error);

        if (action === 'retry') {
          retryCount++;
          log.info('retrying task', { taskSlug: task.slug, retryCount, phase: 'task_execution' });
          await deps.updateFileStatus(task.filePath, 'Todo');
          continue;
        } else if (action === 'skip') {
          log.info('skipping task', { taskSlug: task.slug, phase: 'task_execution' });
          await deps.updateFileStatus(task.filePath, 'Skipped');
          succeeded = true;
        } else if (action === 'cancel') {
          log.info('cancelling story', { storySlug: story.slug, phase: 'task_execution' });
          await deps.updateFileStatus(story.filePath, 'Cancelled');
          await notifier.notify(
            `🚫 ストーリーがキャンセルされました: ${story.slug}`,
            story.slug,
          );
          return 'cancelled';
        } else {
          const _exhaustive: never = action;
          throw new Error(`Unexpected task failure action: ${_exhaustive}`);
        }
      }
    }

    i++;
  }

  return 'completed';
}

async function runDecomposition(
  story: StoryFile,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<'approved' | 'cancelled'> {
  let retryReason: string | undefined;

  while (true) {
    log.info('decomposing story', { storySlug: story.slug, phase: 'decomposition' });
    const drafts = await deps.decomposeTasks(story, retryReason);

    const id = generateApprovalId(story.slug, 'decompose');
    const result = await notifier.requestApproval(
      id,
      formatDecompositionMessage(story, drafts),
      { approve: '承認', reject: 'やり直し', cancel: 'キャンセル' },
      story.slug,
    );

    if (result.action === 'approve') {
      for (const draft of drafts) {
        deps.createTaskFile(story.project, story.slug, draft);
        log.info('task file created', { taskSlug: draft.slug, phase: 'decomposition' });
      }
      return 'approved';
    }

    if (result.action === 'cancel') {
      deps.updateFileStatus(story.filePath, 'Cancelled');
      await notifier.notify(`🚫 ストーリーがキャンセルされました: ${story.slug}`, story.slug);
      log.info('story cancelled', { storySlug: story.slug, phase: 'decomposition' });
      return 'cancelled';
    }

    retryReason = result.reason;
    log.info('decomposition rejected, retrying', { retryReason, phase: 'decomposition' });
  }
}

/**
 * README 更新を試行し、結果に応じて通知を送る共通ヘルパー。
 * リモートがない場合は何もしない。
 * PR が作成された場合はマージされるまでポーリングで待機する。
 */
async function tryDocUpdateAndNotify(
  story: StoryFile,
  tasks: TaskFile[],
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<void> {
  if (detectNoRemote(repoPath)) return;

  try {
    const docResult = await runStoryDocUpdate(story, tasks, repoPath, notifier, deps);
    if (docResult.skipped) {
      const reason = docResult.skipReason ?? '更新不要';
      await notifier.notify(
        `ℹ️ *README 更新スキップ*: \`${story.slug}\`\n*理由*: ${reason}`,
        story.slug,
      );
      return;
    }

    // PR 作成成功 → 却下ボタン付き Block Kit 通知を送信し、マージを待機する
    const readmeBlocks = buildReadmePRBlocks(docResult.prUrl!, story.slug);
    await notifier.notify(
      `📝 *README 更新 PR 作成*: \`${story.slug}\`\n*PR*: ${docResult.prUrl}\nレビュー・マージをお願いします。`,
      story.slug,
      { blocks: readmeBlocks },
    );

    // マージポーリングで待機（pr-lifecycle と同じ仕組み）
    const mergeResult = await runMergePollingLoop(
      docResult.prUrl!,
      repoPath,
      { execGh: deps.execGh },
    );

    if (mergeResult.finalStatus === 'merged') {
      log.info('doc PR merged', { prUrl: docResult.prUrl, phase: 'doc_update' });
      await notifier.notify(
        `✅ *README 更新 PR マージ完了*: \`${story.slug}\`\n*PR*: ${docResult.prUrl}`,
        story.slug,
      );
    } else if (mergeResult.finalStatus === 'rejected') {
      // Slack 却下ボタン経由 — リトライ不要、警告通知のみで Done フローを続行
      log.warn('doc PR rejected via Slack', { prUrl: docResult.prUrl, phase: 'doc_update' });
      await notifier.notify(
        `⚠️ *README 更新 PR 却下*: \`${story.slug}\`\n*PR*: ${docResult.prUrl}`,
        story.slug,
      );
    } else {
      // closed / timeout / error — いずれも致命的ではないのでログ＋通知のみ
      log.warn('doc PR not merged', { finalStatus: mergeResult.finalStatus, prUrl: docResult.prUrl, phase: 'doc_update' });
      await notifier.notify(
        `⚠️ *README 更新 PR 未マージ* (${mergeResult.finalStatus}): \`${story.slug}\`\n*PR*: ${docResult.prUrl}`,
        story.slug,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('story doc update failed', { errorMessage: message, phase: 'doc_update' });
    await notifier.notify(
      `⚠️ *README 更新失敗* (${story.slug}): ${message}\nストーリー完了処理は続行します。`,
      story.slug,
    ).catch(() => {});
  }
}

/**
 * 全タスクのステータスからストーリーの最終ステータスを算出する。
 * 優先度: Cancelled > Failed > Done
 * - Cancelled タスクが1つ以上 → Cancelled
 * - Failed タスクが1つ以上 → Failed
 * - 全タスクが Done or Skipped → Done
 *
 * 前提条件: 全タスクが終端ステータス（Done/Skipped/Failed/Cancelled）であること。
 * 非終端ステータス（Todo/Doing）のタスクが含まれている場合は Error をスローする。
 *
 * @param tasks タスク配列。空配列の場合は 'Done' を返す。
 * @throws {Error} 非終端ステータスのタスクが含まれている場合
 */
export function deriveStoryStatus(tasks: TaskFile[]): StoryStatus {
  if (tasks.length === 0) return 'Done';

  const terminalStatuses: TaskStatus[] = ['Done', 'Skipped', 'Failed', 'Cancelled'];
  const nonTerminal = tasks.filter((t) => !terminalStatuses.includes(t.status));
  if (nonTerminal.length > 0) {
    const details = nonTerminal.map((t) => `${t.slug}(${t.status})`).join(', ');
    throw new Error(`deriveStoryStatus: non-terminal tasks found: ${details}`);
  }

  if (tasks.some((t) => t.status === 'Cancelled')) return 'Cancelled';
  if (tasks.some((t) => t.status === 'Failed')) return 'Failed';
  return 'Done';
}

// --- 内部型: runStory 状態機械のフェーズ遷移 ---
//
// フェーズ遷移図:
//
//   decompose ──→ execute-tasks ──→ acceptance-gate ──→ doc-update ──→ Done
//       │              │     ↑            │
//       └→ terminal    └→ terminal        ├→ terminal (Failed/Cancelled)
//          (Cancelled)    (Cancelled/     └→ execute-tasks (追加タスク)
//                          Doing)
//

type StoryPhase = 'decompose' | 'execute-tasks' | 'acceptance-gate' | 'doc-update';

type StoryPhaseResult =
  | { next: 'execute-tasks' }
  | { next: 'acceptance-gate'; allTasks: TaskFile[] }
  | { next: 'doc-update'; doneTasks: TaskFile[]; messageTs?: string }
  | { next: 'terminal'; status: StoryStatus };

// --- フェーズ関数: runStory の各フェーズを独立した関数として抽出 ---

/**
 * decompose フェーズ: ストーリーを分解してタスクファイルを作成する。
 * タスクが未作成と判定された場合にのみ呼び出される前提。
 */
async function phaseDecompose(
  story: StoryFile,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<StoryPhaseResult> {
  const decompositionResult = await runDecomposition(story, notifier, deps);
  if (decompositionResult === 'cancelled') {
    return { next: 'terminal', status: 'Cancelled' };
  }

  return { next: 'execute-tasks' };
}

/**
 * execute-tasks フェーズ: Todo タスクを順番に実行し、全タスクの終端判定を行う。
 */
async function phaseExecuteTasks(
  story: StoryFile,
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<StoryPhaseResult> {
  const allCurrentTasks = await deps.getStoryTasks(story.project, story.slug);
  const todoTasks = allCurrentTasks.filter((t) => t.status === 'Todo');

  if (todoTasks.length > 0) {
    const taskResult = await runTodoTasks(todoTasks, story, repoPath, notifier, deps);
    if (taskResult === 'cancelled') {
      return { next: 'terminal', status: 'Cancelled' };
    }
  }

  // 全タスクの最新状態を取得してストーリー完了判定
  const terminalStatuses: TaskStatus[] = ['Done', 'Skipped', 'Failed', 'Cancelled'];
  const allTasks = todoTasks.length > 0
    ? await deps.getStoryTasks(story.project, story.slug)
    : allCurrentTasks;
  const allTerminal = allTasks.length > 0 && allTasks.every((t) => terminalStatuses.includes(t.status));

  if (!allTerminal) {
    if (todoTasks.length === 0) {
      const remaining = allTasks.filter((t) => !terminalStatuses.includes(t.status));
      log.info('no todo tasks but story not complete', {
        storySlug: story.slug,
        remaining: remaining.map((t) => `${t.slug}(${t.status})`).join(', '),
        phase: 'story_loop',
      });
    } else {
      const remaining = allTasks.filter((t) => !terminalStatuses.includes(t.status));
      log.info('story not done, remaining tasks', {
        remaining: remaining.map((t) => t.slug).join(', '),
        phase: 'story_loop',
      });
    }
    return { next: 'terminal', status: 'Doing' };
  }

  return { next: 'acceptance-gate', allTasks };
}

/**
 * acceptance-gate フェーズ: 受け入れ条件チェックを実行し、結果に応じて遷移先を決定する。
 * - 全タスク Done/Skipped → 受け入れ条件ゲート実行
 * - Failed/Cancelled タスクあり → ゲートをスキップして terminal
 * - ゲート結果が 'continue' → execute-tasks に戻る（追加タスク実行）
 */
async function phaseAcceptanceGate(
  story: StoryFile,
  allTasks: TaskFile[],
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<StoryPhaseResult> {
  const storyStatus = deriveStoryStatus(allTasks);

  if (storyStatus !== 'Done') {
    // Failed/Cancelled の場合は受け入れ条件ゲートを通さない
    deps.updateFileStatus(story.filePath, storyStatus);
    const summary = allTasks.map((t) => `${t.slug}(${t.status})`).join(', ');
    const icon = storyStatus === 'Cancelled' ? '🚫' : '❌';
    await notifier.notify(`${icon} ストーリー${storyStatus}: ${story.slug}\n${summary}`, story.slug);
    log.info(`story ${storyStatus}`, { storySlug: story.slug, summary, phase: 'story_complete' });
    return { next: 'terminal', status: storyStatus };
  }

  // 全タスク Done/Skipped → 受け入れ条件ゲートを実行
  const gateResult = await runAcceptanceGate(story, allTasks, repoPath, notifier, deps);

  if (gateResult.result === 'done') {
    const doneTasks = allTasks.filter((t) => t.status === 'Done');
    return { next: 'doc-update', doneTasks, messageTs: gateResult.messageTs };
  }

  // gateResult.result === 'continue' → 追加タスクが生成されたのでタスクループを再開
  return { next: 'execute-tasks' };
}

/**
 * doc-update フェーズ: README 更新 → ステータス更新 → 完了通知を行い、最終ステータスを返す。
 */
async function phaseDocUpdate(
  story: StoryFile,
  doneTasks: TaskFile[],
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
  messageTs?: string,
): Promise<StoryStatus> {
  if (doneTasks.length > 0) {
    await tryDocUpdateAndNotify(story, doneTasks, repoPath, notifier, deps);
  }

  deps.updateFileStatus(story.filePath, 'Done');

  const completionMessage = `✅ ストーリー完了: ${story.slug}`;
  if (messageTs) {
    await notifier.notifyUpdate(messageTs, completionMessage, story.slug);
  } else {
    await notifier.notify(completionMessage, story.slug);
  }
  log.info('story done', { storySlug: story.slug, phase: 'story_complete' });

  return 'Done';
}

export async function runStory(
  story: StoryFile,
  notifier: NotificationBackend,
  deps?: RunnerDeps,
): Promise<StoryStatus> {
  const d = deps ?? createDefaultRunnerDeps();
  const repoPath = resolveRepoPath(story.project);
  log.info('starting story', { storySlug: story.slug, phase: 'story_start' });

  const tasks = await d.getStoryTasks(story.project, story.slug);

  // スレッドセッション開始: 起点メッセージを投稿
  const originMessage = buildThreadOriginMessage(story.slug, tasks);
  await notifier.startThread(story.slug, originMessage);
  log.info('thread session started', { storySlug: story.slug, phase: 'thread_session' });

  // 初期フェーズの決定: タスク未作成なら decompose、既存タスクがあれば execute-tasks
  let phase: StoryPhase = tasks.length === 0 ? 'decompose' : 'execute-tasks';
  let finalStatus: StoryStatus = 'Doing';

  // フェーズ間で受け渡すデータ
  let gateAllTasks: TaskFile[] = [];
  let docDoneTasks: TaskFile[] = [];
  let docMessageTs: string | undefined;

  // 状態機械メインループ
  loop: while (true) {
    switch (phase) {
      case 'decompose': {
        const r = await phaseDecompose(story, notifier, d);
        if (r.next === 'terminal') {
          finalStatus = r.status;
          break loop;
        }
        phase = r.next;
        break;
      }
      case 'execute-tasks': {
        const r = await phaseExecuteTasks(story, repoPath, notifier, d);
        if (r.next === 'terminal') {
          finalStatus = r.status;
          break loop;
        }
        if (r.next === 'acceptance-gate') {
          gateAllTasks = r.allTasks;
        }
        phase = r.next;
        break;
      }
      case 'acceptance-gate': {
        const r = await phaseAcceptanceGate(story, gateAllTasks, repoPath, notifier, d);
        if (r.next === 'terminal') {
          finalStatus = r.status;
          break loop;
        }
        if (r.next === 'doc-update') {
          docDoneTasks = r.doneTasks;
          docMessageTs = r.messageTs;
        }
        phase = r.next;
        break;
      }
      case 'doc-update': {
        finalStatus = await phaseDocUpdate(story, docDoneTasks, repoPath, notifier, d, docMessageTs);
        break loop;
      }
    }
  }

  // スレッドセッション終了: メモリを解放
  notifier.endSession(story.slug);
  log.info('thread session ended', { storySlug: story.slug, phase: 'thread_session' });
  return finalStatus;
}
