/**
 * ストーリー承認アクションハンドラー
 *
 * 「✅ 承認してVaultに作成」ボタンと「❌ キャンセル」ボタンの
 * インタラクションを処理する。
 *
 * 承認時: 最終ドラフトをパースしてVaultにストーリーファイルを作成し、
 * スレッドに完了メッセージを投稿、セッションphaseをcompletedに遷移。
 *
 * キャンセル時: セッションphaseをcancelledに遷移し、スレッドに通知。
 */
import type { App, BlockAction } from '@slack/bolt';
import type { Block, KnownBlock } from '@slack/types';
import { config } from '../../config';
import { interactiveSessionManager } from '../interactive-session';
import {
  parseStoryDraft,
  createStoryFile,
  generateSlug,
  type ParsedStoryDraft,
} from '../../vault/story-writer';

/**
 * 承認処理の依存インターフェース（テスト用DI）
 */
export interface StoryApprovalDeps {
  /** Slackチャンネルにメッセージを投稿する */
  postMessage: (params: {
    channel: string;
    text: string;
    thread_ts?: string;
  }) => Promise<{ ts?: string }>;
  /** Slackメッセージを更新する */
  updateMessage: (params: {
    channel: string;
    ts: string;
    text: string;
    blocks?: (Block | KnownBlock)[];
  }) => Promise<void>;
  /** ストーリーファイルをVaultに作成する */
  writeStoryToVault: (
    project: string,
    parsed: ParsedStoryDraft,
    slug?: string,
  ) => string;
}

/**
 * セッションから最終ドラフト（最後のassistantメッセージ）を取得する
 */
export function getLatestDraft(threadTs: string): string | undefined {
  const session = interactiveSessionManager.getSession(threadTs);
  if (!session) return undefined;

  const assistantMessages = session.conversationHistory.filter(
    (m) => m.role === 'assistant',
  );
  return assistantMessages.length > 0
    ? assistantMessages[assistantMessages.length - 1].content
    : undefined;
}

/**
 * 承認アクションの内部処理
 */
export async function handleApproveInternal(
  threadTs: string,
  messageTs: string,
  deps: StoryApprovalDeps,
): Promise<void> {
  const session = interactiveSessionManager.getSession(threadTs);

  if (!session) {
    return;
  }

  // CAS で drafting → approved に遷移（二重承認を防止）
  const transitioned = interactiveSessionManager.compareAndSwapPhase(
    threadTs,
    'drafting',
    'approved',
  );
  if (!transitioned) {
    return;
  }

  // 最終ドラフトを取得
  const draft = getLatestDraft(threadTs);
  if (!draft) {
    await deps.postMessage({
      channel: session.channelId,
      text: ':warning: ドラフトが見つかりません。',
      thread_ts: threadTs,
    });
    return;
  }

  try {
    // ドラフトをパース
    const parsed = parseStoryDraft(draft);

    if (!parsed.title) {
      await deps.postMessage({
        channel: session.channelId,
        text: ':warning: ドラフトからタイトルを抽出できませんでした。スレッドで修正依頼を送ってください。',
        thread_ts: threadTs,
      });
      return;
    }

    // Vaultにストーリーファイルを作成
    const slug = generateSlug(parsed.title);
    const filePath = deps.writeStoryToVault(
      config.watchProject,
      parsed,
      slug,
    );

    // セッションphaseをcompletedに遷移
    interactiveSessionManager.updatePhase(threadTs, 'completed');

    // ボタンを削除してメッセージを更新
    await deps.updateMessage({
      channel: session.channelId,
      ts: messageTs,
      text: '✅ 承認済み',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '✅ 承認済み' },
        },
      ],
    });

    // 完了メッセージをスレッドに投稿
    await deps.postMessage({
      channel: session.channelId,
      text: `✅ ストーリーファイルを作成しました！\n\n📁 *ファイルパス*: \`${filePath}\`\n📝 *スラッグ*: \`${slug}\``,
      thread_ts: threadTs,
    });
  } catch (error) {
    // 詳細なエラー情報はログに記録し、ユーザーには汎用メッセージを表示
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[story-approval] Vault書き込みエラー (thread: ${threadTs}):`, errMsg);
    await deps.postMessage({
      channel: session.channelId,
      text: ':x: Vaultへのストーリー作成に失敗しました。管理者に問い合わせてください。',
      thread_ts: threadTs,
    });
  }
}

/**
 * キャンセルアクションの内部処理
 */
export async function handleCancelInternal(
  threadTs: string,
  messageTs: string,
  deps: StoryApprovalDeps,
): Promise<void> {
  const session = interactiveSessionManager.getSession(threadTs);

  if (!session || session.phase !== 'drafting') {
    return;
  }

  // セッションphaseをcancelledに遷移
  interactiveSessionManager.updatePhase(threadTs, 'cancelled');

  // ボタンを削除してメッセージを更新
  await deps.updateMessage({
    channel: session.channelId,
    ts: messageTs,
    text: '❌ キャンセルされました',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '❌ キャンセルされました' },
      },
    ],
  });

  // キャンセルメッセージをスレッドに投稿
  await deps.postMessage({
    channel: session.channelId,
    text: '❌ ストーリー作成をキャンセルしました。新しいストーリーを作成するには `/ap story <概要>` を使ってください。',
    thread_ts: threadTs,
  });
}

/**
 * Slack App から StoryApprovalDeps を生成する（本番用）
 */
export function createApprovalDepsFromApp(app: App): StoryApprovalDeps {
  return {
    postMessage: async (params) => {
      const res = await app.client.chat.postMessage({
        channel: params.channel,
        text: params.text,
        ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
      });
      return { ts: res.ts };
    },
    updateMessage: async (params) => {
      await app.client.chat.update({
        channel: params.channel,
        ts: params.ts,
        text: params.text,
        ...(params.blocks ? { blocks: params.blocks } : {}),
      });
    },
    writeStoryToVault: createStoryFile,
  };
}

/**
 * ストーリー承認・キャンセルのアクションハンドラーをSlack Appに登録する
 */
export function registerStoryApprovalHandlers(app: App): void {
  const deps = createApprovalDepsFromApp(app);

  // 承認ボタン
  app.action('ap_story_approve', async ({ body, ack }) => {
    await ack();
    const blockBody = body as BlockAction;
    const action = blockBody.actions?.[0];
    if (!action || !('value' in action) || !action.value) {
      console.error('[story-approval] 承認アクションの値が取得できません');
      return;
    }
    const threadTs = action.value;
    const messageTs = blockBody.message?.ts;
    if (!messageTs) {
      console.error('[story-approval] メッセージtsが取得できません');
      return;
    }
    await handleApproveInternal(threadTs, messageTs, deps);
  });

  // キャンセルボタン
  app.action('ap_story_cancel', async ({ body, ack }) => {
    await ack();
    const blockBody = body as BlockAction;
    const action = blockBody.actions?.[0];
    if (!action || !('value' in action) || !action.value) {
      console.error('[story-approval] キャンセルアクションの値が取得できません');
      return;
    }
    const threadTs = action.value;
    const messageTs = blockBody.message?.ts;
    if (!messageTs) {
      console.error('[story-approval] メッセージtsが取得できません');
      return;
    }
    await handleCancelInternal(threadTs, messageTs, deps);
  });
}
