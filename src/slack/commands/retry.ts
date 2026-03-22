import { glob } from 'glob';
import * as path from 'path';
import { config, vaultProjectPath, vaultStoriesPath } from '../../config';
import { getStoryTasks, TaskFile } from '../../vault/reader';
import { updateFileStatus } from '../../vault/writer';
import type { SubcommandHandler } from '../slash-commands';

/**
 * プロジェクト内の全ストーリーからタスクスラッグを検索する
 *
 * tasks/ 配下の全ディレクトリを走査し、slug が一致するタスクファイルを返す。
 */
export async function findTaskBySlug(
  project: string,
  taskSlug: string,
): Promise<TaskFile | undefined> {
  const tasksRoot = path.join(vaultProjectPath(project), 'tasks');
  const storyDirs = await glob(path.join(tasksRoot, '*/'));

  for (const storyDir of storyDirs) {
    const storySlug = path.basename(storyDir);
    const tasks = await getStoryTasks(project, storySlug);
    const found = tasks.find((t) => t.slug === taskSlug);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * /ap retry <task-slug> サブコマンドのハンドラー
 *
 * 失敗タスクのステータスを Todo に戻し、ファイルウォッチャー経由で再実行をトリガーする。
 */
export const handleRetry: SubcommandHandler = async (args, respond) => {
  try {
    const taskSlug = args[0];

    if (!taskSlug) {
      await respond('⚠️ タスクスラッグを指定してください。\n使い方: `/ap retry <task-slug>`');
      return;
    }

    const project = config.watchProject;
    const task = await findTaskBySlug(project, taskSlug);

    if (!task) {
      await respond(`⚠️ タスク \`${taskSlug}\` が見つかりませんでした。スラッグを確認してください。`);
      return;
    }

    if (task.status !== 'Failed') {
      await respond(
        `⚠️ タスク \`${taskSlug}\` のステータスは \`${task.status}\` です。` +
        `\`Failed\` 状態のタスクのみ再実行できます。`,
      );
      return;
    }

    await updateFileStatus(task.filePath, 'Todo');

    if (task.storySlug) {
      const storyFilePath = path.join(vaultStoriesPath(project), `${task.storySlug}.md`);
      try {
        await updateFileStatus(storyFilePath, 'Doing');
      } catch (storyError) {
        // ストーリー更新失敗時はタスクのステータスを元に戻す
        try {
          await updateFileStatus(task.filePath, 'Failed');
        } catch {
          // ロールバックも失敗した場合はログのみ（外側のcatchでユーザーに通知される）
        }
        throw storyError;
      }
    }

    await respond(
      `✅ タスク \`${taskSlug}\` のステータスを \`Todo\` に更新し、` +
      `${task.storySlug ? `ストーリー \`${task.storySlug}\` を \`Doing\` に変更して` : ''}再実行をトリガーしました。`,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await respond(`:warning: リトライ処理中にエラーが発生しました: ${errMsg}`);
  }
};
