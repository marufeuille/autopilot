import { describe, it, expect } from 'vitest';
import {
  buildMergeApprovalMessage,
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

  it('マージ承認依頼のヘッダーが含まれる', () => {
    const msg = buildMergeApprovalMessage(baseCtx);
    expect(msg).toContain('マージ承認依頼');
  });

  it('セルフレビュー通過・CI通過が含まれる', () => {
    const msg = buildMergeApprovalMessage(baseCtx);
    expect(msg).toContain('✅ セルフレビュー通過');
    expect(msg).toContain('✅ CI通過');
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

  it('マージ確認の問いかけが含まれる', () => {
    const msg = buildMergeApprovalMessage(baseCtx);
    expect(msg).toContain('マージしてよろしいですか');
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
  it('merge_approval イベントでマージ承認メッセージが生成される', () => {
    const msg = buildNotificationMessage({
      eventType: 'merge_approval',
      taskSlug: 'task-01',
      storySlug: 'story-01',
    });
    expect(msg).toContain('マージ承認依頼');
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
