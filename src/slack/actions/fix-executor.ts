/**
 * fix修正実行モジュール
 *
 * 承認後にClaude Agentを使って修正コードを生成・適用し、
 * 実行中の進捗や結果をSlackスレッドに投稿する。
 *
 * タイムアウトやClaude APIエラー時のフォールバック処理も担当する。
 */
import { createCommandLogger } from '../../logger';
import { interactiveSessionManager } from '../interactive-session';
import type { ParsedFixDraft } from './fix-approval';

/** デフォルトのfix実行タイムアウト（5分） */
export const FIX_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * fix実行処理の依存インターフェース（テスト用DI）
 */
export interface FixExecutionDeps {
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
  }) => Promise<void>;
  /** Claudeエージェントを使って修正を実行する（signal でキャンセル可能） */
  runFixAgent: (prompt: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * fix修正実行プロンプトを構築する
 *
 * 分析結果をもとにClaudeにコード修正を指示するプロンプトを生成する。
 */
export function buildFixExecutionPrompt(
  parsed: ParsedFixDraft,
  slug: string,
): string {
  return `あなたはソフトウェアエンジニアです。以下のバグ分析に基づいて修正を実施してください。

## バグ修正タスク: ${parsed.title}

## 原因分析
${parsed.analysis}

## 修正方針
${parsed.approach}

## 受け入れ条件
${parsed.acceptance}

## 影響範囲
${parsed.impact}

## 作業指示

1. 上記の原因分析と修正方針に基づいて、コードの修正を行ってください
2. 修正が完了したら、受け入れ条件を確認してください
3. 修正内容のサマリーを最後に出力してください

## 出力形式

修正完了後、以下の形式でサマリーを出力してください:

### 修正サマリー
修正した内容の概要

### 変更ファイル
- ファイル1: 変更内容
- ファイル2: 変更内容

### 確認結果
受け入れ条件の充足状況`;
}

/**
 * タイムアウト付きでPromiseを実行する
 *
 * 指定時間内に完了しない場合はタイムアウトエラーをスローする。
 * AbortController を渡すことで、タイムアウト時に元の処理のキャンセルをシグナルできる。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = '処理がタイムアウトしました',
  abortController?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        // タイムアウト時に AbortController でキャンセルをシグナルする
        if (abortController) {
          abortController.abort();
        }
        reject(new FixExecutionTimeoutError(message, timeoutMs));
      }
    }, timeoutMs);

    promise
      .then((result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
  });
}

/**
 * fix実行タイムアウトエラー
 */
export class FixExecutionTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'FixExecutionTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * エラーの種別を判定してユーザー向けメッセージを生成する
 */
export function classifyExecutionError(error: unknown): {
  userMessage: string;
  errorType: 'timeout' | 'claude_api' | 'unknown';
} {
  if (error instanceof FixExecutionTimeoutError) {
    const minutes = Math.round(error.timeoutMs / 60000);
    return {
      userMessage: `:warning: 修正処理がタイムアウトしました（${minutes}分）。修正内容が大きすぎる可能性があります。\n\n手動での修正をご検討ください。`,
      errorType: 'timeout',
    };
  }

  if (error instanceof Error) {
    // Claude API 関連のエラーを判定
    // 誤判定を防ぐため、Anthropic / Claude 固有のキーワードに限定する
    const msg = error.message.toLowerCase();
    const name = error.name?.toLowerCase() ?? '';
    const isAnthropicError =
      msg.includes('anthropic') ||
      msg.includes('claude') ||
      msg.includes('rate limit') ||
      msg.includes('overloaded') ||
      msg.includes('rate_limit') ||
      name.includes('anthropic') ||
      name.includes('apiconnection') ||
      name.includes('ratelimit') ||
      ('status' in error && typeof (error as any).status === 'number' && [429, 529].includes((error as any).status));
    if (isAnthropicError) {
      return {
        userMessage: `:warning: Claude API エラーが発生しました: ${error.message}\n\nしばらく待ってから再度お試しください。`,
        errorType: 'claude_api',
      };
    }
  }

  const errMsg = error instanceof Error ? error.message : String(error);
  return {
    userMessage: `:x: 修正処理中にエラーが発生しました: ${errMsg}\n\n管理者に問い合わせてください。`,
    errorType: 'unknown',
  };
}

/**
 * 修正実行結果
 */
export interface FixExecutionResult {
  success: boolean;
  summary: string;
  error?: string;
  errorType?: 'timeout' | 'claude_api' | 'unknown';
}

/**
 * Slack mrkdwn インジェクションを防ぐためにエージェント出力をサニタイズする
 *
 * @here, @channel, @everyone などの特殊メンションを無効化し、
 * 予期しないリンクやメンションが投稿されることを防ぐ。
 */
export function sanitizeSlackOutput(text: string): string {
  // 1. Slack 特殊メンション構文（<!here>, <!channel>, <!everyone>）を無効化
  let sanitized = text
    .replace(/<!here\b[^>]*>/gi, '`@here`')
    .replace(/<!channel\b[^>]*>/gi, '`@channel`')
    .replace(/<!everyone\b[^>]*>/gi, '`@everyone`');

  // 2. ユーザーメンション (<@U...>) を無効化
  sanitized = sanitized.replace(/<@([A-Z0-9]+)>/g, '`@$1`');

  // 3. プレーンテキストの @here, @channel, @everyone を無効化
  //    既にバッククォートで囲まれているものは除外する
  sanitized = sanitized.replace(/(?<!`)@here\b(?!`)/gi, '`@here`');
  sanitized = sanitized.replace(/(?<!`)@channel\b(?!`)/gi, '`@channel`');
  sanitized = sanitized.replace(/(?<!`)@everyone\b(?!`)/gi, '`@everyone`');

  return sanitized;
}

/**
 * fix修正実行の本体処理
 *
 * 承認後に呼び出され、以下のフローを実行する:
 * 1. 進捗メッセージ「修正を実行中です...」をスレッドに投稿
 * 2. Claude Agentで修正を実行（タイムアウト付き）
 * 3. 結果（成功/失敗）をスレッドに投稿
 * 4. セッションphaseをcompleted/executingのまま（エラー時）に更新
 */
export async function executeFixInternal(
  threadTs: string,
  channelId: string,
  parsed: ParsedFixDraft,
  slug: string,
  deps: FixExecutionDeps,
  userId?: string,
  timeoutMs: number = FIX_EXECUTION_TIMEOUT_MS,
): Promise<FixExecutionResult> {
  const log = createCommandLogger('fix-executor', { command: 'fix', threadTs, userId });

  // 1. 進捗メッセージを投稿
  log.info('修正実行開始', { phase: 'fix_execution_start', slug });
  const progressRes = await deps.postMessage({
    channel: channelId,
    text: '🔧 *修正を実行中です...*\n\nClaude がコードを分析・修正しています。しばらくお待ちください。',
    thread_ts: threadTs,
  });
  const progressTs = progressRes.ts;

  try {
    // 2. 修正プロンプトを構築してClaude Agentを実行
    const prompt = buildFixExecutionPrompt(parsed, slug);
    log.info('Claude Agent 実行開始', { phase: 'agent_start', slug });

    // タイムアウト時にエージェント処理のキャンセルをシグナルするための AbortController
    const abortController = new AbortController();
    const result = await withTimeout(
      deps.runFixAgent(prompt, abortController.signal),
      timeoutMs,
      `修正処理が${Math.round(timeoutMs / 60000)}分以内に完了しませんでした`,
      abortController,
    );
    log.info('Claude Agent 実行完了', { phase: 'agent_complete', slug });

    // 3. 進捗メッセージを完了に更新
    if (progressTs) {
      await deps.updateMessage({
        channel: channelId,
        ts: progressTs,
        text: '✅ *修正が完了しました*',
      });
    }

    // 4. 修正結果をスレッドに投稿（Slack mrkdwn インジェクション対策でサニタイズ）
    const sanitizedResult = sanitizeSlackOutput(result);
    const resultMessage = `✅ *修正が完了しました*\n\n📝 *スラッグ*: \`${slug}\`\n\n${sanitizedResult}`;
    await deps.postMessage({
      channel: channelId,
      text: resultMessage,
      thread_ts: threadTs,
    });
    log.info('修正結果を投稿', { phase: 'fix_result_posted', slug });

    // 5. セッションphaseをcompletedに遷移
    interactiveSessionManager.updatePhase(threadTs, 'completed');
    log.info('phase 遷移: executing → completed', { phase: 'fix_completed', slug });

    return {
      success: true,
      summary: result,
    };
  } catch (error) {
    // エラー分類
    const classified = classifyExecutionError(error);
    log.error('修正実行中にエラーが発生', {
      phase: 'fix_execution_error',
      slug,
      errorType: classified.errorType,
    }, error);

    // 進捗メッセージをエラーに更新 & エラーメッセージをスレッドに投稿
    // Slack API 障害時にもエラーが上位に伝播しないよう個別に保護する
    try {
      if (progressTs) {
        await deps.updateMessage({
          channel: channelId,
          ts: progressTs,
          text: '❌ *修正処理でエラーが発生しました*',
        });
      }
    } catch (slackError) {
      log.error('進捗メッセージのエラー更新に失敗', { phase: 'slack_update_error', slug }, slackError);
    }

    try {
      await deps.postMessage({
        channel: channelId,
        text: classified.userMessage,
        thread_ts: threadTs,
      });
      log.info('エラーメッセージを投稿', { phase: 'fix_error_posted', slug, errorType: classified.errorType });
    } catch (slackError) {
      log.error('エラーメッセージの投稿に失敗', { phase: 'slack_post_error', slug }, slackError);
    }

    return {
      success: false,
      summary: '',
      error: error instanceof Error ? error.message : String(error),
      errorType: classified.errorType,
    };
  }
}
