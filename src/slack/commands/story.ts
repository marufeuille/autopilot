/**
 * /ap story サブコマンドのハンドラー
 *
 * ユーザーの一文からClaudeにストーリードラフトを生成させ、
 * Slackスレッドに投稿する。セッションを登録してマルチターン対話に備える。
 */
import type { App } from '@slack/bolt';
import { config } from '../../config';
import type { SubcommandHandler } from '../slash-commands';
import {
  interactiveSessionManager,
  type InteractiveSession,
} from '../interactive-session';

/**
 * ストーリードラフト生成の依存インターフェース（テスト用DI）
 */
export interface StoryDraftDeps {
  /** Slackチャンネルにメッセージを投稿する */
  postMessage: (params: {
    channel: string;
    text: string;
    thread_ts?: string;
  }) => Promise<{ ts?: string }>;
  /** Claudeにプロンプトを送ってテキストを生成する */
  generateDraft: (prompt: string) => Promise<string>;
}

/**
 * ストーリードラフト生成用プロンプトを構築する
 */
export function buildStoryDraftPrompt(description: string): string {
  return `あなたはソフトウェア開発のストーリー設計の専門家です。以下のユーザーの要望からストーリーのドラフトを作成してください。

## ユーザーの要望

${description}

## 出力形式

以下の構造でストーリードラフトを作成してください。Markdown形式で出力してください。

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
- 具体的かつ実装可能な粒度で記述してください
- 受け入れ条件は検証可能な形で書いてください`;
}

/**
 * Slack App から StoryDraftDeps を生成する（本番用）
 */
export function createDepsFromApp(app: App): StoryDraftDeps {
  return {
    postMessage: async (params) => {
      const res = await app.client.chat.postMessage({
        channel: params.channel,
        text: params.text,
        ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
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
 * /ap story ハンドラーの内部実装
 *
 * テスト可能にするために deps を受け取る。
 */
export async function handleStoryInternal(
  args: string[],
  respond: (msg: string) => Promise<void>,
  deps: StoryDraftDeps,
): Promise<void> {
  // 引数バリデーション
  if (args.length === 0) {
    await respond(
      '⚠️ ストーリーの概要を指定してください。\n使い方: `/ap story <概要>`',
    );
    return;
  }

  const description = args.join(' ');

  try {
    // スレッド起点メッセージを投稿
    const rootRes = await deps.postMessage({
      channel: config.slack.channelId,
      text: `📝 *ストーリー作成*: ${description}\n\n_ドラフトを生成中..._`,
    });

    const threadTs = rootRes.ts;
    if (!threadTs) {
      await respond(':warning: スレッドの作成に失敗しました。');
      return;
    }

    // Claudeでドラフト生成
    const prompt = buildStoryDraftPrompt(description);
    const draft = await deps.generateDraft(prompt);

    // ドラフトをスレッドに投稿
    await deps.postMessage({
      channel: config.slack.channelId,
      text: draft,
      thread_ts: threadTs,
    });

    // セッションを登録（phase: drafting）
    const session: InteractiveSession = {
      threadTs,
      channelId: config.slack.channelId,
      type: 'story',
      phase: 'drafting',
      description,
      project: config.watchProject,
      conversationHistory: [
        { role: 'user', content: description },
        { role: 'assistant', content: draft },
      ],
    };
    interactiveSessionManager.startSession(session);

    // ephemeral メッセージで案内
    await respond(
      '✅ ストーリードラフトをスレッドに投稿しました。スレッド内で修正依頼を返すと再ドラフトします。',
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await respond(`:warning: ストーリードラフトの生成中にエラーが発生しました: ${errMsg}`);
  }
}

/**
 * /ap story ハンドラーのファクトリ関数
 *
 * Slack App インスタンスを受け取り、SubcommandHandler を返す。
 * クロージャで app をキャプチャすることで、既存のハンドラーインターフェースを維持する。
 */
export function createStoryHandler(app: App): SubcommandHandler {
  const deps = createDepsFromApp(app);
  return (args, respond) => handleStoryInternal(args, respond, deps);
}
