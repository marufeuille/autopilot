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
 * マージ承認依頼メッセージを生成する
 *
 * CI通過後に人間へマージ承認を依頼する際のメッセージ。
 * PR URL・レビューサマリー・CI結果を含む。
 */
export function buildMergeApprovalMessage(ctx: NotificationContext): string {
  const lines: string[] = [
    '🚀 *マージ承認依頼*',
    '',
    `*タスク*: \`${ctx.taskSlug}\``,
    `*ストーリー*: \`${ctx.storySlug}\``,
  ];

  if (ctx.prUrl) {
    lines.push(`*PR*: ${ctx.prUrl}`);
  }

  lines.push('');
  lines.push('✅ セルフレビュー通過');
  lines.push('✅ CI通過');

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
  lines.push('マージしてよろしいですか？');

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
