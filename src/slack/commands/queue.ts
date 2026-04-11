import type { StoryQueueManager } from '../../queue/queue-manager';
import type { SubcommandHandler } from '../slash-commands';

/** slug として許可する文字パターン（英数字・ハイフン・アンダースコアのみ） */
const VALID_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * /ap queue サブコマンドのハンドラーを生成する。
 *
 * プロジェクト別の QueueManagers Map を受け取り、add / cancel / list サブコマンドを処理する。
 * 後方互換のため、単一 StoryQueueManager も受け付ける。
 *
 * - `/ap queue add <story-slug>` — Story を Queued にしてキュー末尾に追加（デフォルトプロジェクト）
 * - `/ap queue add <story-slug> --project=<project>` — 指定プロジェクトのキューに追加
 * - `/ap queue cancel <story-slug>` — キューから削除し Story を Todo に戻す
 * - `/ap queue list` — 全プロジェクトのキューと順序を表示
 */
export function createQueueHandler(
  queueManagerOrMap: StoryQueueManager | Map<string, StoryQueueManager>,
): SubcommandHandler {
  const queueManagers = normalizeToMap(queueManagerOrMap);

  return async (args, respond) => {
    const subAction = args[0];

    if (!subAction) {
      await respond(buildQueueHelpMessage());
      return;
    }

    try {
      switch (subAction) {
        case 'add':
          await handleQueueAdd(queueManagers, args.slice(1), respond);
          break;
        case 'cancel':
          await handleQueueCancel(queueManagers, args.slice(1), respond);
          break;
        case 'list':
          await handleQueueList(queueManagers, respond);
          break;
        default:
          await respond(
            `⚠️ 不明なキューコマンド: \`${subAction}\`\n\n` +
            buildQueueHelpMessage(),
          );
          break;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await respond(`:warning: キュー操作中にエラーが発生しました: ${errMsg}`);
    }
  };
}

/**
 * 単一 QueueManager を Map に正規化する（後方互換用）
 */
function normalizeToMap(
  input: StoryQueueManager | Map<string, StoryQueueManager>,
): Map<string, StoryQueueManager> {
  if (input instanceof Map) return input;
  // 単一 QueueManager の場合、default キーで Map に変換
  return new Map([['default', input]]);
}

/**
 * args から --project=xxx オプションを抽出する
 */
function extractProjectOption(
  args: string[],
  queueManagers: Map<string, StoryQueueManager>,
): { project: string; remainingArgs: string[] } {
  const remainingArgs: string[] = [];
  let project: string | undefined;

  for (const arg of args) {
    const match = arg.match(/^--project=(.+)$/);
    if (match) {
      project = match[1];
    } else {
      remainingArgs.push(arg);
    }
  }

  // 未指定時はデフォルトプロジェクト（Map の最初のキー）にフォールバック
  if (!project) {
    project = queueManagers.keys().next().value!;
  }

  return { project, remainingArgs };
}

/**
 * プロジェクト名から QueueManager を解決する
 */
function resolveQueueManager(
  queueManagers: Map<string, StoryQueueManager>,
  project: string,
): StoryQueueManager {
  const qm = queueManagers.get(project);
  if (!qm) {
    throw new Error(
      `プロジェクト "${project}" は監視対象ではありません。` +
      `利用可能: ${[...queueManagers.keys()].join(', ')}`,
    );
  }
  return qm;
}

/**
 * /ap queue add <story-slug> [--project=<project>]
 */
async function handleQueueAdd(
  queueManagers: Map<string, StoryQueueManager>,
  args: string[],
  respond: (msg: string) => Promise<void>,
): Promise<void> {
  const { project, remainingArgs } = extractProjectOption(args, queueManagers);
  const storySlug = remainingArgs[0];

  if (!storySlug) {
    await respond('⚠️ ストーリースラッグを指定してください。\n使い方: `/ap queue add <story-slug>`');
    return;
  }

  if (!VALID_SLUG_PATTERN.test(storySlug)) {
    await respond('⚠️ 不正なストーリースラッグです。英数字・ハイフン・アンダースコアのみ使用できます。');
    return;
  }

  const qm = resolveQueueManager(queueManagers, project);
  const story = qm.add(storySlug);
  const position = qm.list().length;
  const projectSuffix = queueManagers.size > 1 ? ` [${project}]` : '';
  await respond(
    `✅ ストーリー \`${story.slug}\` をキューに追加しました（位置: ${position}）${projectSuffix}`,
  );
}

/**
 * /ap queue cancel <story-slug> [--project=<project>]
 */
async function handleQueueCancel(
  queueManagers: Map<string, StoryQueueManager>,
  args: string[],
  respond: (msg: string) => Promise<void>,
): Promise<void> {
  const { project, remainingArgs } = extractProjectOption(args, queueManagers);
  const storySlug = remainingArgs[0];

  if (!storySlug) {
    await respond('⚠️ ストーリースラッグを指定してください。\n使い方: `/ap queue cancel <story-slug>`');
    return;
  }

  if (!VALID_SLUG_PATTERN.test(storySlug)) {
    await respond('⚠️ 不正なストーリースラッグです。英数字・ハイフン・アンダースコアのみ使用できます。');
    return;
  }

  const qm = resolveQueueManager(queueManagers, project);
  qm.cancel(storySlug);
  const projectSuffix = queueManagers.size > 1 ? ` [${project}]` : '';
  await respond(
    `✅ ストーリー \`${storySlug}\` をキューから削除し、ステータスを \`Todo\` に戻しました${projectSuffix}`,
  );
}

/**
 * /ap queue list
 *
 * 全プロジェクトのキューをまとめて表示する。
 */
async function handleQueueList(
  queueManagers: Map<string, StoryQueueManager>,
  respond: (msg: string) => Promise<void>,
): Promise<void> {
  const allEmpty = [...queueManagers.values()].every((qm) => qm.list().length === 0);

  if (allEmpty) {
    await respond('📋 キューは空です');
    return;
  }

  const sections: string[] = [];

  for (const [project, qm] of queueManagers) {
    const queue = qm.list();
    if (queue.length === 0 && queueManagers.size > 1) continue;

    const lines = queue.map((story, index) => {
      return `${index + 1}. \`${story.slug}\` — ${story.status}`;
    });

    const paused = qm.isQueuePaused ? '\n⏸️ キューは現在 *一時停止中* です' : '';

    if (queueManagers.size > 1) {
      sections.push(
        `*${project}* (${queue.length}件)\n${lines.join('\n')}${paused}`,
      );
    } else {
      sections.push(
        `${lines.join('\n')}${paused}`,
      );
    }
  }

  const totalCount = [...queueManagers.values()].reduce((sum, qm) => sum + qm.list().length, 0);
  await respond(
    `📋 *ストーリーキュー* (${totalCount}件)\n\n${sections.join('\n\n---\n\n')}`,
  );
}

/**
 * queue サブコマンドのヘルプメッセージ
 */
function buildQueueHelpMessage(): string {
  return [
    '📖 `/ap queue` コマンドの使い方:',
    '',
    '• `/ap queue add <story-slug>` — ストーリーをキューに追加',
    '• `/ap queue cancel <story-slug>` — ストーリーをキューから削除',
    '• `/ap queue list` — キューの内容を表示',
  ].join('\n');
}
