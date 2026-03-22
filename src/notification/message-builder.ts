/**
 * 通知メッセージビルダー
 *
 * 通知イベント種別に応じた構造化メッセージを生成する。
 * Slack mrkdwn 形式で出力し、ローカル通知ではストリップして使用する。
 */

import { NotificationContext } from './types';
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
