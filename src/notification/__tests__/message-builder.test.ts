import { describe, it, expect } from 'vitest';
import {
  buildMergeApprovalMessage,
  buildMergeCompletedMessage,
  buildMergeBlockedMessage,
  buildReviewEscalationMessage,
  buildCIEscalationMessage,
  buildNotificationMessage,
} from '../message-builder';
import type { NotificationContext } from '../types';

describe('buildMergeApprovalMessage', () => {
  const baseCtx: NotificationContext = {
    eventType: 'merge_approval',
    taskSlug: 'my-task-01',
    storySlug: 'my-story',
  };

  it('タスクとストーリー名が含まれる', () => {
    const msg = buildMergeApprovalMessage(baseCtx);
    expect(msg).toContain('my-task-01');
    expect(msg).toContain('my-story');
  });

  it('マージ実行依頼のヘッダーが含まれる', () => {
    const msg = buildMergeApprovalMessage(baseCtx);
    expect(msg).toContain('マージ実行依頼');
  });

  it('mergeConditions未設定時はセルフレビュー通過・CI通過が含まれる（後方互換）', () => {
    const msg = buildMergeApprovalMessage(baseCtx);
    expect(msg).toContain('✅ セルフレビュー通過');
    expect(msg).toContain('✅ CI通過');
  });

  it('mergeConditions設定時は各条件の充足状況が表示される', () => {
    const msg = buildMergeApprovalMessage({
      ...baseCtx,
      mergeConditions: [
        { passed: true, label: 'セルフレビュー通過' },
        { passed: true, label: 'CI通過' },
        { passed: true, label: 'PRがオープン状態' },
        { passed: false, label: '承認数が不足しています' },
      ],
      mergeReady: false,
    });
    expect(msg).toContain('✅ セルフレビュー通過');
    expect(msg).toContain('✅ CI通過');
    expect(msg).toContain('✅ PRがオープン状態');
    expect(msg).toContain('❌ 承認数が不足しています');
  });

  it('mergeReady=false の場合にマージ不可メッセージが表示される', () => {
    const msg = buildMergeApprovalMessage({
      ...baseCtx,
      mergeConditions: [
        { passed: false, label: 'CI未完了' },
      ],
      mergeReady: false,
    });
    expect(msg).toContain('マージ条件が未充足');
    expect(msg).not.toContain('マージを実行してよろしいですか');
  });

  it('mergeReady=true の場合にマージ実行の説明と確認メッセージが表示される', () => {
    const msg = buildMergeApprovalMessage({
      ...baseCtx,
      mergeConditions: [
        { passed: true, label: 'セルフレビュー通過' },
        { passed: true, label: 'CI通過' },
      ],
      mergeReady: true,
    });
    expect(msg).toContain('マージ実行');
    expect(msg).toContain('レビュー承認とは別の操作');
    expect(msg).toContain('マージを実行してよろしいですか');
  });

  it('PR URLが含まれる', () => {
    const msg = buildMergeApprovalMessage({
      ...baseCtx,
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(msg).toContain('https://github.com/org/repo/pull/42');
  });

  it('レビューサマリーが含まれる', () => {
    const msg = buildMergeApprovalMessage({
      ...baseCtx,
      reviewSummary: 'コードは問題なし',
    });
    expect(msg).toContain('レビューサマリー');
    expect(msg).toContain('コードは問題なし');
  });

  it('CI実行URLが含まれる', () => {
    const msg = buildMergeApprovalMessage({
      ...baseCtx,
      ciRunUrl: 'https://github.com/org/repo/actions/runs/123',
    });
    expect(msg).toContain('https://github.com/org/repo/actions/runs/123');
  });
});

describe('buildMergeCompletedMessage', () => {
  it('マージ完了メッセージにタスクslugとPR URLが含まれる', () => {
    const msg = buildMergeCompletedMessage('my-task-01', 'https://github.com/org/repo/pull/42');
    expect(msg).toContain('マージ完了');
    expect(msg).toContain('my-task-01');
    expect(msg).toContain('https://github.com/org/repo/pull/42');
    expect(msg).toContain('merged');
  });
});

describe('buildMergeBlockedMessage', () => {
  it('マージ不可メッセージに条件一覧が表示される', () => {
    const msg = buildMergeBlockedMessage('my-task-01', 'https://github.com/org/repo/pull/42', [
      { passed: true, label: 'セルフレビュー通過' },
      { passed: false, label: 'CIが未完了です' },
      { passed: false, label: '承認数が不足しています' },
    ]);
    expect(msg).toContain('マージ不可');
    expect(msg).toContain('my-task-01');
    expect(msg).toContain('✅ セルフレビュー通過');
    expect(msg).toContain('❌ CIが未完了です');
    expect(msg).toContain('❌ 承認数が不足しています');
    expect(msg).toContain('再度マージを実行してください');
  });
});

describe('buildReviewEscalationMessage', () => {
  const baseCtx: NotificationContext = {
    eventType: 'review_escalation',
    taskSlug: 'task-02',
    storySlug: 'story-a',
  };

  it('エスカレーションのヘッダーが含まれる', () => {
    const msg = buildReviewEscalationMessage(baseCtx);
    expect(msg).toContain('エスカレーション');
  });

  it('人間による確認が必要な旨が含まれる', () => {
    const msg = buildReviewEscalationMessage(baseCtx);
    expect(msg).toContain('人間による確認が必要');
  });

  it('タスクとストーリー名が含まれる', () => {
    const msg = buildReviewEscalationMessage(baseCtx);
    expect(msg).toContain('task-02');
    expect(msg).toContain('story-a');
  });

  it('PR URLが含まれる場合に表示される', () => {
    const msg = buildReviewEscalationMessage({
      ...baseCtx,
      prUrl: 'https://github.com/org/repo/pull/99',
    });
    expect(msg).toContain('https://github.com/org/repo/pull/99');
  });

  it('レビューサマリーが含まれる', () => {
    const msg = buildReviewEscalationMessage({
      ...baseCtx,
      reviewSummary: 'セキュリティ上の問題あり',
    });
    expect(msg).toContain('セキュリティ上の問題あり');
  });
});

describe('buildCIEscalationMessage', () => {
  const baseCtx: NotificationContext = {
    eventType: 'ci_escalation',
    taskSlug: 'task-03',
    storySlug: 'story-b',
  };

  it('CI失敗エスカレーションのヘッダーが含まれる', () => {
    const msg = buildCIEscalationMessage(baseCtx);
    expect(msg).toContain('CI失敗');
    expect(msg).toContain('エスカレーション');
  });

  it('人間による確認が必要な旨が含まれる', () => {
    const msg = buildCIEscalationMessage(baseCtx);
    expect(msg).toContain('人間による確認が必要');
  });

  it('PR URLが含まれる', () => {
    const msg = buildCIEscalationMessage({
      ...baseCtx,
      prUrl: 'https://github.com/org/repo/pull/55',
    });
    expect(msg).toContain('https://github.com/org/repo/pull/55');
  });

  it('CI結果サマリーが含まれる', () => {
    const msg = buildCIEscalationMessage({
      ...baseCtx,
      ciSummary: 'テスト3件失敗',
    });
    expect(msg).toContain('テスト3件失敗');
  });

  it('CI実行URLが含まれる', () => {
    const msg = buildCIEscalationMessage({
      ...baseCtx,
      ciRunUrl: 'https://github.com/org/repo/actions/runs/456',
    });
    expect(msg).toContain('https://github.com/org/repo/actions/runs/456');
  });
});

describe('buildNotificationMessage', () => {
  it('merge_approval イベントでマージ実行依頼メッセージが生成される', () => {
    const msg = buildNotificationMessage({
      eventType: 'merge_approval',
      taskSlug: 'task-01',
      storySlug: 'story-01',
    });
    expect(msg).toContain('マージ実行依頼');
  });

  it('review_escalation イベントでレビューエスカレーションメッセージが生成される', () => {
    const msg = buildNotificationMessage({
      eventType: 'review_escalation',
      taskSlug: 'task-01',
      storySlug: 'story-01',
    });
    expect(msg).toContain('セルフレビュー エスカレーション');
  });

  it('ci_escalation イベントでCIエスカレーションメッセージが生成される', () => {
    const msg = buildNotificationMessage({
      eventType: 'ci_escalation',
      taskSlug: 'task-01',
      storySlug: 'story-01',
    });
    expect(msg).toContain('CI失敗 エスカレーション');
  });

  it('review_result イベントでレビュー結果メッセージが生成される', () => {
    const msg = buildNotificationMessage({
      eventType: 'review_result',
      taskSlug: 'task-01',
      storySlug: 'story-01',
      reviewSummary: 'OK判定',
    });
    expect(msg).toContain('セルフレビュー結果');
    expect(msg).toContain('OK判定');
  });

  it('ci_result イベントでCI結果メッセージが生成される', () => {
    const msg = buildNotificationMessage({
      eventType: 'ci_result',
      taskSlug: 'task-01',
      storySlug: 'story-01',
      ciSummary: 'All checks passed',
    });
    expect(msg).toContain('CI結果');
    expect(msg).toContain('All checks passed');
  });
});
