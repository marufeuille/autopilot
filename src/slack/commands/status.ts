import { glob } from 'glob';
import * as path from 'path';
import { config, vaultStoriesPath } from '../../config';
import { readStoryFile, getStoryTasks, TaskStatus } from '../../vault/reader';
import type { SubcommandHandler } from '../slash-commands';

/** タスクステータスごとの絵文字 */
const STATUS_EMOJI: Record<TaskStatus, string> = {
  Todo: '\u{26AA}',   // ⚪
  Doing: '\u{1F535}',  // 🔵
  Done: '\u{2705}',   // ✅
  Failed: '\u{274C}', // ❌
  Skipped: '\u{23ED}\u{FE0F}', // ⏭️
  Cancelled: '\u{1F6AB}', // 🚫
};

/**
 * ストーリー配下のタスク状態を集計する
 */
export function summarizeTaskStatuses(
  statuses: TaskStatus[],
): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    Todo: 0,
    Doing: 0,
    Done: 0,
    Failed: 0,
    Skipped: 0,
    Cancelled: 0,
  };
  for (const s of statuses) {
    counts[s]++;
  }
  return counts;
}

/**
 * ステータス集計を1行テキストにフォーマットする
 */
export function formatStatusSummary(counts: Record<TaskStatus, number>): string {
  const parts: string[] = [];
  for (const status of ['Done', 'Doing', 'Todo', 'Failed', 'Skipped'] as TaskStatus[]) {
    if (counts[status] > 0) {
      parts.push(`${STATUS_EMOJI[status]} ${status}: ${counts[status]}`);
    }
  }
  return parts.join('  ');
}

/**
 * /ap status サブコマンドのハンドラー
 *
 * ウォッチ対象の全プロジェクトのストーリーから status=Doing のものを抽出し、
 * 各ストーリー配下のタスク状態を集計して Slack に返す。
 */
export const handleStatus: SubcommandHandler = async (_args, respond) => {
  try {
    const projects = config.watchProjects;

    // 全プロジェクトのストーリーファイルを収集
    const allStoryFiles: string[] = [];
    for (const project of projects) {
      const storiesDir = vaultStoriesPath(project);
      const pattern = path.join(storiesDir, '*.md');
      const files = await glob(pattern);
      allStoryFiles.push(...files);
    }

    // Doing のストーリーを抽出
    const doingStories = allStoryFiles
      .map((fp) => readStoryFile(fp))
      .filter((s) => s.status === 'Doing');

    if (doingStories.length === 0) {
      await respond('現在実行中のストーリーはありません');
      return;
    }

    // 各ストーリーのタスク情報を並列取得
    const storyDetails = await Promise.all(
      doingStories.map(async (story) => {
        const tasks = await getStoryTasks(story.project, story.slug);
        return { story, tasks };
      }),
    );

    const multiProject = projects.length > 1;

    // Slack Block Kit mrkdwn でフォーマット
    const sections = storyDetails.map(({ story, tasks }) => {
      const taskStatuses = tasks.map((t) => t.status);
      const counts = summarizeTaskStatuses(taskStatuses);
      const summary = formatStatusSummary(counts);

      const taskLines = tasks
        .map((t) => `  ${STATUS_EMOJI[t.status]} \`${t.slug}\` — ${t.status}`)
        .join('\n');

      const projectLabel = multiProject ? ` [${story.project}]` : '';
      return [
        `*${story.slug}*${projectLabel}  (${tasks.length} tasks)`,
        summary,
        taskLines,
      ]
        .filter(Boolean)
        .join('\n');
    });

    const message = `:clipboard: *実行中のストーリー* (${doingStories.length})\n\n${sections.join('\n\n---\n\n')}`;

    await respond(message);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await respond(`:warning: ステータス取得中にエラーが発生しました: ${errMsg}`);
  }
};
