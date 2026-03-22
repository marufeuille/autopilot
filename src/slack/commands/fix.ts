/**
 * /ap fix サブコマンドのハンドラー
 *
 * ユーザーのバグ説明からClaudeに原因分析と修正方針を生成させ、
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
 * fix分析生成の依存インターフェース（テスト用DI）
 */
export interface FixDraftDeps {
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
 * バグ分析用プロンプトを構築する
 */
export function buildFixAnalysisPrompt(bugDescription: string): string {
  return `あなたはソフトウェア開発のバグ分析・修正の専門家です。以下のバグ報告から原因分析と修正方針を作成してください。

## バグ報告

${bugDescription}

## 出力形式

以下の構造で分析結果を作成してください。Markdown形式で出力してください。

### タイトル
バグ修正のタイトル（簡潔に、「fix:」で始める）

### 原因分析
バグの推定原因を記述してください。考えられる原因を具体的に説明してください。

### 修正方針
修正のアプローチを記述してください。どのファイル・コンポーネントをどのように修正するかを説明してください。

### 受け入れ条件
修正が完了したことを確認するための条件をチェックリスト形式で記述してください。
- [ ] 条件1
- [ ] 条件2
...

### 影響範囲
この修正が影響する可能性のある他の機能やコンポーネントを記述してください。

## 注意事項

- 日本語で回答してください
- 具体的かつ実装可能な粒度で記述してください
- 受け入れ条件は検証可能な形で書いてください`;
}

/**
 * Slack App から FixDraftDeps を生成する（本番用）
 */
export function createFixDepsFromApp(app: App): FixDraftDeps {
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
 * /ap fix ハンドラーの内部実装
 *
 * テスト可能にするために deps を受け取る。
 */
export async function handleFixInternal(
  args: string[],
  respond: (msg: string) => Promise<void>,
  deps: FixDraftDeps,
): Promise<void> {
  // 引数バリデーション
  if (args.length === 0) {
    await respond(
      '⚠️ バグの説明を指定してください。\n使い方: `/ap fix <バグ説明>`',
    );
    return;
  }

  const bugDescription = args.join(' ');

  try {
    // スレッド起点メッセージを投稿
    const rootRes = await deps.postMessage({
      channel: config.slack.channelId,
      text: `🐛 *バグ修正*: ${bugDescription}\n\n_原因分析中..._`,
    });

    const threadTs = rootRes.ts;
    if (!threadTs) {
      await respond(':warning: スレッドの作成に失敗しました。');
      return;
    }

    // Claudeでバグ分析生成
    const prompt = buildFixAnalysisPrompt(bugDescription);
    const analysis = await deps.generateDraft(prompt);

    // 分析結果をスレッドに投稿
    await deps.postMessage({
      channel: config.slack.channelId,
      text: analysis,
      thread_ts: threadTs,
    });

    // セッションを登録（phase: drafting, type: fix）
    const session: InteractiveSession = {
      threadTs,
      channelId: config.slack.channelId,
      type: 'fix',
      phase: 'drafting',
      description: bugDescription,
      conversationHistory: [
        { role: 'user', content: bugDescription },
        { role: 'assistant', content: analysis },
      ],
    };
    interactiveSessionManager.startSession(session);

    // ephemeral メッセージで案内
    await respond(
      '✅ バグ分析をスレッドに投稿しました。スレッド内で修正依頼を返すと再分析します。',
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await respond(`:warning: バグ分析の生成中にエラーが発生しました: ${errMsg}`);
  }
}

/**
 * /ap fix ハンドラーのファクトリ関数
 *
 * Slack App インスタンスを受け取り、SubcommandHandler を返す。
 */
export function createFixHandler(app: App): SubcommandHandler {
  const deps = createFixDepsFromApp(app);
  return (args, respond) => handleFixInternal(args, respond, deps);
}
