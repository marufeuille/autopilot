/**
 * スレッド内マルチターン修正ハンドラー
 *
 * phase: 'drafting' のセッションに紐づくスレッドへの返信を検出し、
 * 過去の会話コンテキストと合わせてClaudeに再ドラフトを依頼する。
 * 再ドラフトの末尾に承認ボタン（Block Kit actions）を付与する。
 */
import type { App } from '@slack/bolt';
import type { Block, KnownBlock } from '@slack/types';
import { config } from '../config';
import {
  interactiveSessionManager,
  type ConversationMessage,
  type InteractiveSession,
} from './interactive-session';

/**
 * 再ドラフト処理の依存インターフェース（テスト用DI）
 */
export interface RedraftDeps {
  /** Slackチャンネルにメッセージを投稿する（blocks 対応） */
  postMessage: (params: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: (Block | KnownBlock)[];
  }) => Promise<{ ts?: string }>;
  /** Claudeにプロンプトを送ってテキストを生成する */
  generateDraft: (prompt: string) => Promise<string>;
}

/**
 * 再ドラフト用プロンプトを構築する
 *
 * 会話履歴全体と最新の修正依頼を組み合わせてClaudeに渡す。
 */
export function buildRedraftPrompt(
  session: InteractiveSession,
  userMessage: string,
): string {
  const historyText = session.conversationHistory
    .map((msg) => `【${msg.role === 'user' ? 'ユーザー' : 'アシスタント'}】\n${msg.content}`)
    .join('\n\n---\n\n');

  return `あなたはソフトウェア開発のストーリー設計の専門家です。以下の会話履歴を踏まえ、ユーザーの修正依頼に基づいてストーリードラフトを修正してください。

## 会話履歴

${historyText}

## 最新の修正依頼

${userMessage}

## 出力形式

修正版のストーリードラフトを以下の構造で出力してください。Markdown形式で出力してください。

### タイトル
ストーリーのタイトル（簡潔に）

### 価値・ゴール
このストーリーが完了することで得られる価値、達成するゴールを記述してください。

### 受け入れ条件
完了を判定するための具体的な条件をチェックリスト形式で記述してください。
- [ ] 条件1
- [ ] 条件2
...

### タスク案
このストーリーを実現するために必要なタスク（PR単位）を概要レベルで列挙してください。
1. タスク1の概要
2. タスク2の概要
...

## 注意事項

- 日本語で回答してください
- 修正依頼の内容を反映した上で、ドラフト全体の整合性を保ってください
- 具体的かつ実装可能な粒度で記述してください
- 受け入れ条件は検証可能な形で書いてください`;
}

/**
 * 承認ボタン付きの Block Kit ブロックを構築する
 */
export function buildApprovalBlocks(
  draftText: string,
  threadTs: string,
): (Block | KnownBlock)[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: draftText },
    },
    {
      type: 'actions',
      block_id: `draft_actions_${threadTs}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ 承認してVaultに作成' },
          style: 'primary' as const,
          action_id: 'ap_story_approve',
          value: threadTs,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ キャンセル' },
          style: 'danger' as const,
          action_id: 'ap_story_cancel',
          value: threadTs,
        },
      ],
    },
  ];
}

/**
 * スレッド内メッセージの再ドラフト処理（内部実装）
 *
 * テスト可能にするために deps を受け取る。
 */
export async function handleThreadMessageInternal(
  threadTs: string,
  userMessage: string,
  deps: RedraftDeps,
): Promise<void> {
  const session = interactiveSessionManager.getSession(threadTs);

  // セッションが存在しない、または drafting フェーズでなければ無視
  if (!session || session.phase !== 'drafting') {
    return;
  }

  // 会話履歴にユーザーの修正依頼を追加
  interactiveSessionManager.addMessage(threadTs, {
    role: 'user',
    content: userMessage,
  });

  try {
    // 再ドラフト用プロンプトを構築してClaudeに送信
    const prompt = buildRedraftPrompt(session, userMessage);
    const draft = await deps.generateDraft(prompt);

    // 会話履歴にClaudeの再ドラフトを追加
    interactiveSessionManager.addMessage(threadTs, {
      role: 'assistant',
      content: draft,
    });

    // 承認ボタン付きで再ドラフトをスレッドに投稿
    const blocks = buildApprovalBlocks(draft, threadTs);
    await deps.postMessage({
      channel: session.channelId,
      text: draft,
      thread_ts: threadTs,
      blocks,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await deps.postMessage({
      channel: session.channelId,
      text: `:warning: 再ドラフトの生成中にエラーが発生しました: ${errMsg}`,
      thread_ts: threadTs,
    });
  }
}

/**
 * Slack App から RedraftDeps を生成する（本番用）
 */
export function createRedraftDepsFromApp(app: App): RedraftDeps {
  return {
    postMessage: async (params) => {
      const res = await app.client.chat.postMessage({
        channel: params.channel,
        text: params.text,
        ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
        ...(params.blocks ? { blocks: params.blocks } : {}),
      });
      return { ts: res.ts };
    },
    generateDraft: async (prompt: string) => {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      let fullText = '';
      for await (const message of query({
        prompt,
        options: {
          allowedTools: [],
          permissionMode: 'bypassPermissions',
        },
      })) {
        if (message.type === 'assistant') {
          const content = message.message?.content ?? [];
          for (const block of content) {
            if ('text' in block && block.text) {
              fullText += block.text;
            }
          }
        }
      }
      return fullText;
    },
  };
}

/**
 * スレッド内メッセージイベントハンドラーを Slack App に登録する
 *
 * ボットの自メッセージは無視し、draftingフェーズのセッションに
 * 紐づくスレッド返信のみを処理する。
 */
export function registerThreadHandler(app: App): void {
  const deps = createRedraftDepsFromApp(app);

  app.event('message', async ({ event }) => {
    const msg = event as any;

    // ボットの自メッセージは無視
    if (msg.bot_id || msg.subtype === 'bot_message') {
      return;
    }

    // スレッド内のメッセージのみ処理（thread_ts がある = スレッド返信）
    const threadTs = msg.thread_ts;
    if (!threadTs) {
      return;
    }

    // テキストがないメッセージは無視
    const text = msg.text;
    if (!text || typeof text !== 'string') {
      return;
    }

    await handleThreadMessageInternal(threadTs, text, deps);
  });
}
