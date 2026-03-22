import { glob } from 'glob';
import * as path from 'path';
import { config, vaultProjectPath } from '../../config';
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
  const storyDirs = await glob(path.join(tasksRoot, '*'), { onlyDirectories: true } as never);

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

    updateFileStatus(task.filePath, 'Todo');

    await respond(
      `✅ タスク \`${taskSlug}\` のステータスを \`Todo\` に更新しました。` +
      `ファイルウォッチャーにより自動的に再実行されます。`,
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await respond(`:warning: リトライ処理中にエラーが発生しました: ${errMsg}`);
  }
};
