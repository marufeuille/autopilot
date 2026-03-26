import type { StoryQueueManager } from '../../queue/queue-manager';
import type { SubcommandHandler } from '../slash-commands';

/** slug として許可する文字パターン（英数字・ハイフン・アンダースコアのみ） */
const VALID_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * /ap queue サブコマンドのハンドラーを生成する。
 *
 * QueueManager インスタンスを受け取り、add / cancel / list サブコマンドを処理する。
 *
 * - `/ap queue add <story-slug>` — Story を Queued にしてキュー末尾に追加
 * - `/ap queue cancel <story-slug>` — キューから削除し Story を Todo に戻す
 * - `/ap queue list` — 現在のキューと順序を表示
 */
export function createQueueHandler(queueManager: StoryQueueManager): SubcommandHandler {
  return async (args, respond) => {
    const subAction = args[0];

    if (!subAction) {
      await respond(buildQueueHelpMessage());
      return;
    }

    try {
      switch (subAction) {
        case 'add':
          await handleQueueAdd(queueManager, args.slice(1), respond);
          break;
        case 'cancel':
          await handleQueueCancel(queueManager, args.slice(1), respond);
          break;
        case 'list':
          await handleQueueList(queueManager, respond);
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
 * /ap queue add <story-slug>
 */
async function handleQueueAdd(
  queueManager: StoryQueueManager,
  args: string[],
  respond: (msg: string) => Promise<void>,
): Promise<void> {
  const storySlug = args[0];
  if (!storySlug) {
    await respond('⚠️ ストーリースラッグを指定してください。\n使い方: `/ap queue add <story-slug>`');
    return;
  }

  if (!VALID_SLUG_PATTERN.test(storySlug)) {
    await respond('⚠️ 不正なストーリースラッグです。英数字・ハイフン・アンダースコアのみ使用できます。');
    return;
  }

  const story = queueManager.add(storySlug);
  const position = queueManager.list().length;
  await respond(
    `✅ ストーリー \`${story.slug}\` をキューに追加しました（位置: ${position}）`,
  );
}

/**
 * /ap queue cancel <story-slug>
 */
async function handleQueueCancel(
  queueManager: StoryQueueManager,
  args: string[],
  respond: (msg: string) => Promise<void>,
): Promise<void> {
  const storySlug = args[0];
  if (!storySlug) {
    await respond('⚠️ ストーリースラッグを指定してください。\n使い方: `/ap queue cancel <story-slug>`');
    return;
  }

  if (!VALID_SLUG_PATTERN.test(storySlug)) {
    await respond('⚠️ 不正なストーリースラッグです。英数字・ハイフン・アンダースコアのみ使用できます。');
    return;
  }

  queueManager.cancel(storySlug);
  await respond(
    `✅ ストーリー \`${storySlug}\` をキューから削除し、ステータスを \`Todo\` に戻しました`,
  );
}

/**
 * /ap queue list
 */
async function handleQueueList(
  queueManager: StoryQueueManager,
  respond: (msg: string) => Promise<void>,
): Promise<void> {
  const queue = queueManager.list();

  if (queue.length === 0) {
    await respond('📋 キューは空です');
    return;
  }

  const lines = queue.map((story, index) => {
    return `${index + 1}. \`${story.slug}\` — ${story.status}`;
  });

  const paused = queueManager.isQueuePaused ? '\n\n⏸️ キューは現在 *一時停止中* です' : '';

  await respond(
    `📋 *ストーリーキュー* (${queue.length}件)\n\n${lines.join('\n')}${paused}`,
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
