/**
 * fix承認アクションハンドラー
 *
 * 「✅ 承認して修正を開始」ボタンと「❌ キャンセル」ボタンの
 * インタラクションを処理する。
 *
 * 承認時: 最終分析をパースしてVaultにfix用ストーリーファイルを作成し、
 * ストーリーのstatusをDoingにして自動実行をトリガーする。
 * phaseは drafting → approved → executing と遷移する。
 *
 * キャンセル時: セッションphaseをcancelledに遷移し、スレッドに通知。
 */
import type { App, BlockAction } from '@slack/bolt';
import type { Block, KnownBlock } from '@slack/types';
import { createCommandLogger, logInfo, logError } from '../../logger';
import { interactiveSessionManager } from '../interactive-session';
import { executeFixInternal, type FixExecutionDeps } from './fix-executor';

/**
 * fix分析ドラフトのパース結果
 */
export interface ParsedFixDraft {
  title: string;
  analysis: string;
  approach: string;
  acceptance: string;
  impact: string;
}

/**
 * fix分析ドラフトをパースする
 *
 * ### タイトル / ### 原因分析 / ### 修正方針 / ### 受け入れ条件 / ### 影響範囲
 * の各セクションを抽出する。
 */
export function parseFixDraft(draft: string): ParsedFixDraft {
  const sections: Record<string, string> = {};
  let currentKey = '';

  for (const line of draft.split('\n')) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      currentKey = headerMatch[1].trim();
      sections[currentKey] = '';
    } else if (currentKey) {
      sections[currentKey] += line + '\n';
    }
  }

  const trim = (key: string) => (sections[key] ?? '').trim();

  return {
    title: trim('タイトル'),
    analysis: trim('原因分析'),
    approach: trim('修正方針'),
    acceptance: trim('受け入れ条件'),
    impact: trim('影響範囲'),
  };
}

/**
 * fix用ストーリーファイルの内容を構築する
 *
 * status: Doing で作成し、ファイルウォッチャーによる自動実行をトリガーする。
 */
export function buildFixStoryFileContent(
  parsed: ParsedFixDraft,
  slug: string,
  project: string,
): string {
  const today = new Date().toISOString().slice(0, 10);

  // gray-matter形式のフロントマターを構築
  const lines = [
    '---',
    'status: Doing',
    'priority: high',
    'effort: low',
    `slug: ${slug}`,
    `project: ${project}`,
    `created: ${today}`,
    '---',
    '',
    `# ${parsed.title}`,
    '',
    '## 価値・ゴール',
    '',
    parsed.analysis,
    '',
    '## 受け入れ条件',
    '',
    parsed.acceptance,
    '',
    '## タスク',
    '',
    parsed.approach,
    '',
    '## メモ',
    '',
    `影響範囲: ${parsed.impact}`,
    '',
  ];

  return lines.join('\n');
}

/**
 * 承認処理の依存インターフェース（テスト用DI）
 */
export interface FixApprovalDeps {
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
  /** fix用ストーリーファイルをVaultに書き込む */
  writeFixStoryToVault: (
    project: string,
    content: string,
    slug: string,
  ) => string;
  /** Claudeエージェントを使って修正を実行する（省略時はVault書き込みのみ、signal でキャンセル可能） */
  runFixAgent?: (prompt: string, signal?: AbortSignal) => Promise<string>;
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
 * タイトル文字列からスラッグを生成する（fix用）
 */
export function generateFixSlug(now?: Date): string {
  const timestamp = now ?? new Date();
  const dateStr = timestamp.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = timestamp.toISOString().slice(11, 19).replace(/:/g, '');
  return `fix-${dateStr}-${timeStr}`;
}

/**
 * fix承認アクションの内部処理
 *
 * phase遷移: drafting → approved → executing
 */
export async function handleFixApproveInternal(
  threadTs: string,
  messageTs: string,
  deps: FixApprovalDeps,
  userId?: string,
): Promise<void> {
  const log = createCommandLogger('fix-approval', { command: 'fix', threadTs, userId });
  const session = interactiveSessionManager.getSession(threadTs);

  if (!session) {
    log.warn('セッションが見つからない', { phase: 'approve_received' });
    return;
  }

  log.info('承認アクション受信', { phase: 'approve_received' });

  // CAS で drafting → approved に遷移（二重承認を防止）
  const transitioned = interactiveSessionManager.compareAndSwapPhase(
    threadTs,
    'drafting',
    'approved',
  );
  if (!transitioned) {
    log.warn('phase 遷移失敗（二重承認の可能性）', { phase: 'approve_cas_failed', currentPhase: session.phase });
    return;
  }
  log.info('phase 遷移: drafting → approved', { phase: 'approve_phase_transition' });

  // 最終ドラフトを取得
  const draft = getLatestDraft(threadTs);
  if (!draft) {
    log.warn('最終ドラフトが見つからない', { phase: 'approve_draft_missing' });
    await deps.postMessage({
      channel: session.channelId,
      text: ':warning: 分析ドラフトが見つかりません。',
      thread_ts: threadTs,
    });
    return;
  }

  try {
    // ドラフトをパース
    const parsed = parseFixDraft(draft);

    if (!parsed.title) {
      log.warn('タイトル抽出失敗、drafting に戻す', { phase: 'approve_parse_failed' });
      await deps.postMessage({
        channel: session.channelId,
        text: ':warning: ドラフトからタイトルを抽出できませんでした。スレッドで修正依頼を送ってください。',
        thread_ts: threadTs,
      });
      // approved に遷移済みだが、タイトルが取れないので drafting に戻す
      interactiveSessionManager.updatePhase(threadTs, 'drafting');
      return;
    }

    // fix用スラッグ生成
    const slug = generateFixSlug();
    log.info('ドラフトパース完了', { phase: 'approve_parsed', slug });

    // fix用ストーリーファイル内容を構築（status: Doing）
    const fileContent = buildFixStoryFileContent(parsed, slug, session.project);

    // Vaultにファイルを作成
    log.info('Vault ファイル作成開始', { phase: 'vault_write_start', slug });
    const filePath = deps.writeFixStoryToVault(
      session.project,
      fileContent,
      slug,
    );
    log.info('Vault ファイル作成完了', { phase: 'vault_write_complete', slug, filePath });

    // ボタンを削除してメッセージを更新
    await deps.updateMessage({
      channel: session.channelId,
      ts: messageTs,
      text: '✅ 承認済み - 修正を開始します',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '✅ 承認済み - 修正を開始します' },
        },
      ],
    });

    // phase を executing に遷移
    interactiveSessionManager.updatePhase(threadTs, 'executing');
    log.info('phase 遷移: approved → executing', { phase: 'execution_start', slug });

    // 実行開始通知をスレッドに投稿
    await deps.postMessage({
      channel: session.channelId,
      text: `🚀 修正を開始しました！\n\n📁 *ストーリーファイル*: \`${filePath}\`\n📝 *スラッグ*: \`${slug}\``,
      thread_ts: threadTs,
    });
    log.info('実行開始通知を投稿', { phase: 'execution_notified' });

    // runFixAgent が提供されている場合は修正実行を開始する
    if (deps.runFixAgent) {
      log.info('修正実行フローを開始', { phase: 'fix_execution_trigger', slug });

      const executionDeps: FixExecutionDeps = {
        postMessage: deps.postMessage,
        updateMessage: async (params) => {
          await deps.updateMessage({
            channel: params.channel,
            ts: params.ts,
            text: params.text,
          });
        },
        runFixAgent: deps.runFixAgent,
      };

      // 非同期で実行（awaitして完了まで待つ）
      await executeFixInternal(
        threadTs,
        session.channelId,
        parsed,
        slug,
        executionDeps,
        userId,
      );
    } else {
      log.info('runFixAgent 未設定のためファイルウォッチャーによる実行に委譲', { phase: 'execution_delegated', slug });
    }
  } catch (error) {
    log.error('承認処理中にエラーが発生', { phase: 'approve_error' }, error);
    const errMsg = error instanceof Error ? error.message : String(error);
    await deps.postMessage({
      channel: session.channelId,
      text: ':x: fix用ストーリーの作成に失敗しました。管理者に問い合わせてください。',
      thread_ts: threadTs,
    });
  }
}

/**
 * fixキャンセルアクションの内部処理
 */
export async function handleFixCancelInternal(
  threadTs: string,
  messageTs: string,
  deps: FixApprovalDeps,
  userId?: string,
): Promise<void> {
  const log = createCommandLogger('fix-approval', { command: 'fix', threadTs, userId });
  const session = interactiveSessionManager.getSession(threadTs);

  if (!session || session.phase !== 'drafting') {
    log.warn('キャンセル不可（セッションなし or phase不一致）', { phase: 'cancel_received' });
    return;
  }

  log.info('キャンセルアクション受信', { phase: 'cancel_received' });

  // セッションphaseをcancelledに遷移
  interactiveSessionManager.updatePhase(threadTs, 'cancelled');
  log.info('phase 遷移: drafting → cancelled', { phase: 'cancel_phase_transition' });

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
    text: '❌ バグ修正をキャンセルしました。新しいバグ修正を依頼するには `/ap fix <バグ説明>` を使ってください。',
    thread_ts: threadTs,
  });
}

/**
 * Vault にfix用ストーリーファイルを書き込む（本番用）
 */
function writeFixStoryToVault(
  project: string,
  content: string,
  slug: string,
): string {
  const fs = require('fs');
  const path = require('path');
  const { vaultStoriesPath } = require('../../config');

  const storiesDir = vaultStoriesPath(project);
  const filePath = path.join(storiesDir, `${slug}.md`);

  if (fs.existsSync(filePath)) {
    throw new Error(`Story file already exists: ${filePath}`);
  }

  fs.mkdirSync(storiesDir, { recursive: true });
  fs.writeFileSync(filePath, content);

  return filePath;
}

/**
 * Slack App から FixApprovalDeps を生成する（本番用）
 */
export function createFixApprovalDepsFromApp(app: App): FixApprovalDeps {
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
    writeFixStoryToVault,
    runFixAgent: async (prompt: string, signal?: AbortSignal) => {
      let queryFn: typeof import('@anthropic-ai/claude-agent-sdk')['query'];
      try {
        const mod = await import('@anthropic-ai/claude-agent-sdk');
        queryFn = mod.query;
      } catch (importError) {
        throw new Error(
          `claude-agent-sdk のインポートに失敗しました: ${importError instanceof Error ? importError.message : String(importError)}`,
        );
      }
      let fullText = '';
      for await (const message of queryFn({
        prompt,
        options: {
          allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
          permissionMode: 'plan',
          ...(signal ? { abortSignal: signal } : {}),
        },
      })) {
        // タイムアウトによるキャンセルをチェック
        if (signal?.aborted) {
          break;
        }
        if (message.type === 'assistant') {
          const content = message.message?.content ?? [];
          for (const block of content) {
            if ('text' in block && typeof block.text === 'string') {
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
 * fix承認・キャンセルのアクションハンドラーをSlack Appに登録する
 */
export function registerFixApprovalHandlers(app: App): void {
  const deps = createFixApprovalDepsFromApp(app);

  logInfo('fix承認アクションハンドラーを登録', { module: 'fix-approval', command: 'fix', phase: 'handler_registered' });

  // 承認ボタン
  app.action('ap_fix_approve', async ({ body, ack }) => {
    await ack();
    const blockBody = body as BlockAction;
    const userId = blockBody.user?.id;
    const action = blockBody.actions?.[0];

    logInfo('fix承認ボタン押下を受信', {
      module: 'fix-approval',
      command: 'fix',
      userId,
      phase: 'interactive_payload_received',
      actionId: 'ap_fix_approve',
    });

    if (!action || !('value' in action) || !action.value) {
      logError('承認アクションの値が取得できません', { module: 'fix-approval', command: 'fix', userId, phase: 'action_parse_error' });
      return;
    }
    const threadTs = action.value;
    const messageTs = blockBody.message?.ts;
    if (!messageTs) {
      logError('メッセージtsが取得できません', { module: 'fix-approval', command: 'fix', userId, phase: 'action_parse_error', threadTs });
      return;
    }

    logInfo('fix承認ペイロード解析完了', {
      module: 'fix-approval',
      command: 'fix',
      userId,
      phase: 'payload_parsed',
      threadTs,
      messageTs,
    });

    await handleFixApproveInternal(threadTs, messageTs, deps, userId);
  });

  // キャンセルボタン
  app.action('ap_fix_cancel', async ({ body, ack }) => {
    await ack();
    const blockBody = body as BlockAction;
    const userId = blockBody.user?.id;
    const action = blockBody.actions?.[0];

    logInfo('fixキャンセルボタン押下を受信', {
      module: 'fix-approval',
      command: 'fix',
      userId,
      phase: 'interactive_payload_received',
      actionId: 'ap_fix_cancel',
    });

    if (!action || !('value' in action) || !action.value) {
      logError('キャンセルアクションの値が取得できません', { module: 'fix-approval', command: 'fix', userId, phase: 'action_parse_error' });
      return;
    }
    const threadTs = action.value;
    const messageTs = blockBody.message?.ts;
    if (!messageTs) {
      logError('メッセージtsが取得できません', { module: 'fix-approval', command: 'fix', userId, phase: 'action_parse_error', threadTs });
      return;
    }

    logInfo('fixキャンセルペイロード解析完了', {
      module: 'fix-approval',
      command: 'fix',
      userId,
      phase: 'payload_parsed',
      threadTs,
      messageTs,
    });

    await handleFixCancelInternal(threadTs, messageTs, deps, userId);
  });
}
