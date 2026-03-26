/**
 * 通知メッセージビルダー
 *
 * 通知イベント種別に応じた構造化メッセージを生成する。
 * Slack mrkdwn 形式で出力し、ローカル通知ではストリップして使用する。
 */

import type { KnownBlock } from '@slack/types';
import type { ModalView } from '@slack/types';
import { NotificationContext } from './types';
import type { AcceptanceCheckResult } from './types';
import type { TaskFile } from '../vault/reader';

/**
 * スレッド起点メッセージを生成する
 *
 * ストーリー実行開始時にスレッドの起点として投稿するメッセージ。
 * ストーリータイトル（slug）と実行対象タスク一覧を含む。
 *
 * @param storySlug ストーリーの識別子
 * @param tasks 実行対象のタスク一覧
 */
export function buildThreadOriginMessage(storySlug: string, tasks: TaskFile[]): string {
  const lines: string[] = [
    `🚀 *ストーリー実行開始*: \`${storySlug}\``,
    '',
  ];

  if (tasks.length > 0) {
    lines.push('*タスク一覧:*');
    for (const task of tasks) {
      const statusIcon = task.status === 'Todo' ? '⬜' : task.status === 'Done' ? '✅' : '▶️';
      lines.push(`${statusIcon} \`${task.slug}\` (${task.status})`);
    }
  } else {
    lines.push('_タスク未分解 — この後タスク分解を実行します_');
  }

  return lines.join('\n');
}

/**
 * マージ実行依頼メッセージを生成する
 *
 * CI通過後に人間へマージ実行を依頼する際のメッセージ。
 * 「承認（レビューApprove）」と「マージ実行」が別操作であることを明示する。
 * PR URL・レビューサマリー・CI結果・マージ条件の充足状況を含む。
 */
export function buildMergeApprovalMessage(ctx: NotificationContext): string {
  const lines: string[] = [
    '🚀 *マージ実行依頼*',
    '',
    `*タスク*: \`${ctx.taskSlug}\``,
    `*ストーリー*: \`${ctx.storySlug}\``,
  ];

  if (ctx.prUrl) {
    lines.push(`*PR*: ${ctx.prUrl}`);
  }

  // マージ条件の詳細表示
  lines.push('');
  lines.push('*マージ条件:*');
  if (ctx.mergeConditions && ctx.mergeConditions.length > 0) {
    for (const condition of ctx.mergeConditions) {
      const icon = condition.passed ? '✅' : '❌';
      lines.push(`${icon} ${condition.label}`);
    }
  } else {
    // mergeConditions が未設定の場合は従来互換（セルフレビュー・CI通過を表示）
    lines.push('✅ セルフレビュー通過');
    lines.push('✅ CI通過');
  }

  if (ctx.reviewSummary) {
    lines.push('');
    lines.push('*レビューサマリー:*');
    lines.push(ctx.reviewSummary);
  }

  if (ctx.ciRunUrl) {
    lines.push('');
    lines.push(`*CI結果*: ${ctx.ciRunUrl}`);
  }

  lines.push('');
  if (ctx.mergeReady === false) {
    lines.push('⚠️ マージ条件が未充足のため、マージを実行できません。条件を確認してください。');
  } else {
    lines.push('ℹ️ このボタンを押すとPRが *マージ実行* されます（レビュー承認とは別の操作です）');
    lines.push('マージを実行してよろしいですか？');
  }

  return lines.join('\n');
}

/**
 * マージ完了メッセージを生成する
 *
 * マージ成功後にステータスが「merged」に更新されたことをユーザーに通知する。
 */
export function buildMergeCompletedMessage(taskSlug: string, prUrl: string): string {
  return [
    '✅ *マージ完了*',
    '',
    `*タスク*: \`${taskSlug}\``,
    `*PR*: ${prUrl}`,
    `*ステータス*: \`merged\``,
    '',
    'PRのマージが完了し、ステータスが `merged` に更新されました。',
  ].join('\n');
}

/**
 * マージブロックメッセージを生成する
 *
 * マージ条件未充足時にユーザーに具体的な理由を表示する。
 */
export function buildMergeBlockedMessage(
  taskSlug: string,
  prUrl: string,
  conditions: { passed: boolean; label: string }[],
): string {
  const lines: string[] = [
    '🚫 *マージ不可*',
    '',
    `*タスク*: \`${taskSlug}\``,
    `*PR*: ${prUrl}`,
    '',
    '*マージ条件:*',
  ];

  for (const condition of conditions) {
    const icon = condition.passed ? '✅' : '❌';
    lines.push(`${icon} ${condition.label}`);
  }

  lines.push('');
  lines.push('上記の条件を解消した後、再度マージを実行してください。');

  return lines.join('\n');
}

/**
 * レビューエスカレーション通知メッセージを生成する
 *
 * セルフレビューNGがリトライ上限に到達した際のエスカレーション通知。
 */
export function buildReviewEscalationMessage(ctx: NotificationContext): string {
  const lines: string[] = [
    '⚠️ *セルフレビュー エスカレーション*',
    '',
    `*タスク*: \`${ctx.taskSlug}\``,
    `*ストーリー*: \`${ctx.storySlug}\``,
  ];

  if (ctx.prUrl) {
    lines.push(`*PR*: ${ctx.prUrl}`);
  }

  lines.push('');
  lines.push('セルフレビューが最大リトライ回数に到達しましたが、指摘事項が解消されませんでした。');
  lines.push('人間による確認が必要です。');

  if (ctx.reviewSummary) {
    lines.push('');
    lines.push('*レビューサマリー:*');
    lines.push(ctx.reviewSummary);
  }

  return lines.join('\n');
}

/**
 * CI失敗エスカレーション通知メッセージを生成する
 *
 * CI失敗がリトライ上限に到達した際のエスカレーション通知。
 */
export function buildCIEscalationMessage(ctx: NotificationContext): string {
  const lines: string[] = [
    '⚠️ *CI失敗 エスカレーション*',
    '',
    `*タスク*: \`${ctx.taskSlug}\``,
    `*ストーリー*: \`${ctx.storySlug}\``,
  ];

  if (ctx.prUrl) {
    lines.push(`*PR*: ${ctx.prUrl}`);
  }

  lines.push('');
  lines.push('CI失敗の自動修正が最大リトライ回数に到達しました。');
  lines.push('人間による確認が必要です。');

  if (ctx.ciSummary) {
    lines.push('');
    lines.push('*CI結果サマリー:*');
    lines.push(ctx.ciSummary);
  }

  if (ctx.ciRunUrl) {
    lines.push('');
    lines.push(`*CI実行ログ*: ${ctx.ciRunUrl}`);
  }

  return lines.join('\n');
}

/** Slack Button value の最大文字数 */
const SLACK_BUTTON_VALUE_MAX = 2000;
/** Slack private_metadata の最大文字数 */
const SLACK_PRIVATE_METADATA_MAX = 3000;

/**
 * PR URL をサニタイズする
 *
 * Slack mrkdwn インジェクションを防ぐために `<`, `>`, `|` を除去し、
 * Slack API の文字数制限内に収まるようバリデーションを行う。
 *
 * @param prUrl 生の PR URL
 * @param maxLength 許容する最大文字数（デフォルト: SLACK_BUTTON_VALUE_MAX）
 * @returns サニタイズ済み URL
 * @throws maxLength を超過した場合
 */
export function sanitizePrUrl(prUrl: string, maxLength: number = SLACK_BUTTON_VALUE_MAX): string {
  const sanitized = prUrl.replace(/[<>|]/g, '');
  if (sanitized.length > maxLength) {
    throw new Error(
      `PR URL が ${maxLength} 文字を超えています (${sanitized.length} 文字): URL を確認してください`,
    );
  }
  // サニタイズ後の文字列が有効な URL であることを検証する
  try {
    new URL(sanitized);
  } catch {
    throw new Error(
      `PR URL が不正な形式です: ${sanitized}`,
    );
  }
  return sanitized;
}

/**
 * 「マージ準備完了」通知の Block Kit ブロックを生成する
 *
 * CI 通過後にユーザーへ手動マージを促す通知。
 * NG ボタン（action_id: 'pr_reject_ng'）を含み、
 * クリックすると却下理由入力モーダルが開く。
 *
 * @param prUrl PR の URL（NG ボタンの value に埋め込む）
 * @param taskSlug タスクの識別子
 */
export function buildMergeReadyBlocks(prUrl: string, taskSlug: string): KnownBlock[] {
  // Slack mrkdwn のリンク構文を防ぐため <url|label> 形式でリンク化する
  const safeUrl = sanitizePrUrl(prUrl);
  const linkedUrl = `<${safeUrl}|${safeUrl}>`;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *マージ準備完了*: \`${taskSlug}\`\n*PR*: ${linkedUrl}\nCIが通過しました。GitHubから手動でマージしてください。`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ NG（却下）' },
          style: 'danger',
          action_id: 'pr_reject_ng',
          value: safeUrl,
        },
      ],
    },
  ];
}

/**
 * PR 却下理由入力モーダルの view 定義を生成する
 *
 * @param prUrl PR の URL（private_metadata に埋め込む）
 */
export function buildRejectModal(prUrl: string): ModalView {
  const safeUrl = sanitizePrUrl(prUrl, SLACK_PRIVATE_METADATA_MAX);
  return {
    type: 'modal',
    callback_id: 'pr_reject_modal',
    private_metadata: safeUrl,
    title: { type: 'plain_text', text: '却下理由' },
    submit: { type: 'plain_text', text: '送信' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'input',
        block_id: 'reason_block',
        element: {
          type: 'plain_text_input',
          action_id: 'reason_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '却下理由を入力してください',
          },
        },
        label: { type: 'plain_text', text: '理由' },
      },
    ],
  };
}

/**
 * Task失敗時の Block Kit ブロックを生成する
 *
 * ストーリースレッドに投稿するボタン付きメッセージ。
 * 3つのボタン（リトライ / スキップして次へ / ストーリーをキャンセル）を含む。
 *
 * @param id ボタン value に埋め込む一意識別子（pending map のキー）
 * @param taskSlug 失敗したタスクの識別子
 * @param storySlug ストーリーの識別子
 * @param errorSummary エラーの概要
 */
export function buildTaskFailureBlocks(
  id: string,
  taskSlug: string,
  storySlug: string,
  errorSummary: string,
): KnownBlock[] {
  const metadata = JSON.stringify({ id, taskSlug, storySlug });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `❌ *タスク失敗*: \`${taskSlug}\`\n` +
          `*ストーリー*: \`${storySlug}\`\n` +
          `*エラー*: ${errorSummary}\n\n` +
          `対応を選択してください。`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'リトライ' },
          style: 'primary',
          action_id: 'cwk_task_retry',
          value: metadata,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'スキップして次へ' },
          action_id: 'cwk_task_skip',
          value: metadata,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'ストーリーをキャンセル' },
          style: 'danger',
          action_id: 'cwk_task_cancel',
          value: metadata,
        },
      ],
    },
  ];
}

/**
 * キュー停止時の Block Kit ブロックを生成する
 *
 * Story Failed によるキュー停止時にストーリースレッドに投稿するボタン付きメッセージ。
 * 3つのボタン（スキップして次へ / このStoryをリトライ / キューをすべてクリア）を含む。
 *
 * @param id ボタン value に埋め込む一意識別子（pending map のキー）
 * @param storySlug 失敗したストーリーの識別子
 * @param message 通知メッセージ
 */
export function buildQueueFailedBlocks(
  id: string,
  storySlug: string,
  message: string,
): KnownBlock[] {
  const metadata = JSON.stringify({ id, storySlug });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: message,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'スキップして次へ' },
          action_id: 'cwk_queue_resume',
          value: metadata,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'このStoryをリトライ' },
          style: 'primary',
          action_id: 'cwk_queue_retry',
          value: metadata,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'キューをすべてクリア' },
          style: 'danger',
          action_id: 'cwk_queue_clear',
          value: metadata,
        },
      ],
    },
  ];
}

/**
 * 通知コンテキストからイベント種別に応じたメッセージを生成する
 */
export function buildNotificationMessage(ctx: NotificationContext): string {
  switch (ctx.eventType) {
    case 'merge_approval':
      return buildMergeApprovalMessage(ctx);
    case 'review_escalation':
      return buildReviewEscalationMessage(ctx);
    case 'ci_escalation':
      return buildCIEscalationMessage(ctx);
    case 'review_result':
      return buildReviewResultMessage(ctx);
    case 'ci_result':
      return buildCIResultMessage(ctx);
  }
}

/**
 * レビュー結果通知メッセージを生成する（情報通知）
 */
function buildReviewResultMessage(ctx: NotificationContext): string {
  const lines: string[] = [
    `*セルフレビュー結果* (\`${ctx.taskSlug}\`)`,
  ];

  if (ctx.reviewSummary) {
    lines.push('');
    lines.push(ctx.reviewSummary);
  }

  if (ctx.prUrl) {
    lines.push('');
    lines.push(`*PR*: ${ctx.prUrl}`);
  }

  return lines.join('\n');
}

/**
 * CI結果通知メッセージを生成する（情報通知）
 */
function buildCIResultMessage(ctx: NotificationContext): string {
  const lines: string[] = [
    `*CI結果* (\`${ctx.taskSlug}\`)`,
  ];

  if (ctx.ciSummary) {
    lines.push('');
    lines.push(ctx.ciSummary);
  }

  if (ctx.ciRunUrl) {
    lines.push(`*CI実行ログ*: ${ctx.ciRunUrl}`);
  }

  if (ctx.prUrl) {
    lines.push(`*PR*: ${ctx.prUrl}`);
  }

  return lines.join('\n');
}

/**
 * 受け入れ条件ゲートの Block Kit ブロックを生成する
 *
 * 全条件 PASS の場合は「Story を Done にする」ボタンを表示し、
 * 一部 FAIL の場合は「このまま Done にする」「コメントして追加タスクを作る」ボタンを表示する。
 *
 * @param id ボタン value に埋め込む一意識別子（pending map のキー）
 * @param storySlug ストーリーの識別子
 * @param checkResult 受け入れ条件チェック結果
 */
export function buildAcceptanceGateBlocks(
  id: string,
  storySlug: string,
  checkResult: AcceptanceCheckResult,
): KnownBlock[] {
  const metadata = JSON.stringify({ id, storySlug });

  // チェック結果のテキスト
  const conditionLines = checkResult.conditions.map((c) => {
    const icon = c.passed ? '✅' : '❌';
    return `${icon} ${c.condition}\n    _${c.reason}_`;
  });

  const headerIcon = checkResult.allPassed ? '✅' : '⚠️';
  const headerText = checkResult.allPassed
    ? '受け入れ条件チェック: 全条件 PASS'
    : '受け入れ条件チェック: 一部 FAIL';

  const sectionText =
    `${headerIcon} *${headerText}*\n` +
    `*ストーリー*: \`${storySlug}\`\n\n` +
    conditionLines.join('\n');

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: sectionText,
      },
    },
  ];

  if (checkResult.allPassed) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Story を Done にする' },
          style: 'primary',
          action_id: 'cwk_acceptance_done',
          value: metadata,
        },
      ],
    });
  } else {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'このまま Done にする' },
          action_id: 'cwk_acceptance_force_done',
          value: metadata,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'コメントして追加タスクを作る' },
          style: 'primary',
          action_id: 'cwk_acceptance_comment',
          value: metadata,
        },
      ],
    });
  }

  return blocks;
}

/**
 * 受け入れ条件コメント入力モーダルの view 定義を生成する
 *
 * @param id 識別子（private_metadata に埋め込む）
 * @param storySlug ストーリーの識別子
 */
export function buildAcceptanceCommentModal(id: string, storySlug: string): ModalView {
  const privateMetadata = JSON.stringify({ id, storySlug });
  return {
    type: 'modal',
    callback_id: 'cwk_acceptance_comment_modal',
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: '追加タスクのコメント' },
    submit: { type: 'plain_text', text: '送信' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'input',
        block_id: 'comment_block',
        element: {
          type: 'plain_text_input',
          action_id: 'comment_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '追加で必要な作業や修正内容を入力してください',
          },
        },
        label: { type: 'plain_text', text: 'コメント' },
      },
    ],
  };
}
