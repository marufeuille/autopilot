import { describe, it, expect } from 'vitest';
import {
  buildMergeApprovalMessage,
  buildMergeCompletedMessage,
  buildMergeBlockedMessage,
  buildReviewEscalationMessage,
  buildCIEscalationMessage,
  buildNotificationMessage,
  buildTaskFailureBlocks,
  buildQueueFailedBlocks,
  buildAcceptanceGateBlocks,
  buildAcceptanceCommentModal,
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

describe('buildTaskFailureBlocks', () => {
  const id = 'test-story--failure-test-task--123';
  const taskSlug = 'test-task';
  const storySlug = 'test-story';
  const errorSummary = 'Agent process crashed';

  it('section ブロックにタスク名・ストーリー名・エラーメッセージが含まれる', () => {
    const blocks = buildTaskFailureBlocks(id, taskSlug, storySlug, errorSummary);
    const section = blocks.find((b) => b.type === 'section') as any;
    expect(section).toBeDefined();
    expect(section.text.text).toContain(taskSlug);
    expect(section.text.text).toContain(storySlug);
    expect(section.text.text).toContain(errorSummary);
    expect(section.text.text).toContain('タスク失敗');
  });

  it('actions ブロックにリトライ・スキップ・キャンセルの3ボタンが含まれる', () => {
    const blocks = buildTaskFailureBlocks(id, taskSlug, storySlug, errorSummary);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(3);
  });

  it('リトライボタンの action_id が cwk_task_retry である', () => {
    const blocks = buildTaskFailureBlocks(id, taskSlug, storySlug, errorSummary);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    const retryBtn = actions.elements.find((e: any) => e.action_id === 'cwk_task_retry');
    expect(retryBtn).toBeDefined();
    expect(retryBtn.text.text).toBe('リトライ');
    expect(retryBtn.style).toBe('primary');
  });

  it('スキップボタンの action_id が cwk_task_skip である', () => {
    const blocks = buildTaskFailureBlocks(id, taskSlug, storySlug, errorSummary);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    const skipBtn = actions.elements.find((e: any) => e.action_id === 'cwk_task_skip');
    expect(skipBtn).toBeDefined();
    expect(skipBtn.text.text).toBe('スキップして次へ');
  });

  it('キャンセルボタンの action_id が cwk_task_cancel である', () => {
    const blocks = buildTaskFailureBlocks(id, taskSlug, storySlug, errorSummary);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    const cancelBtn = actions.elements.find((e: any) => e.action_id === 'cwk_task_cancel');
    expect(cancelBtn).toBeDefined();
    expect(cancelBtn.text.text).toBe('ストーリーをキャンセル');
    expect(cancelBtn.style).toBe('danger');
  });

  it('ボタンの value に id, taskSlug, storySlug が JSON で埋め込まれる', () => {
    const blocks = buildTaskFailureBlocks(id, taskSlug, storySlug, errorSummary);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    for (const element of actions.elements) {
      const parsed = JSON.parse(element.value);
      expect(parsed.id).toBe(id);
      expect(parsed.taskSlug).toBe(taskSlug);
      expect(parsed.storySlug).toBe(storySlug);
    }
  });
});

describe('buildAcceptanceGateBlocks', () => {
  const id = 'test-story--acceptance-gate--123';
  const storySlug = 'test-story';

  describe('全条件PASSの場合', () => {
    const checkResult = {
      allPassed: true,
      conditions: [
        { condition: 'ログインAPIが動作する', passed: true, reason: 'テスト通過' },
        { condition: 'テストが通る', passed: true, reason: '全テスト通過' },
      ],
    };

    it('section ブロックにストーリー名と全条件 PASS が含まれる', () => {
      const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);
      const section = blocks.find((b) => b.type === 'section') as any;
      expect(section).toBeDefined();
      expect(section.text.text).toContain(storySlug);
      expect(section.text.text).toContain('全条件 PASS');
      expect(section.text.text).toContain('✅');
    });

    it('各条件のPASS表示が含まれる', () => {
      const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);
      const section = blocks.find((b) => b.type === 'section') as any;
      expect(section.text.text).toContain('✅ ログインAPIが動作する');
      expect(section.text.text).toContain('テスト通過');
      expect(section.text.text).toContain('✅ テストが通る');
      expect(section.text.text).toContain('全テスト通過');
    });

    it('「Story を Done にする」ボタンが表示される', () => {
      const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);
      const actions = blocks.find((b) => b.type === 'actions') as any;
      expect(actions).toBeDefined();
      expect(actions.elements).toHaveLength(1);
      expect(actions.elements[0].action_id).toBe('cwk_acceptance_done');
      expect(actions.elements[0].text.text).toBe('Story を Done にする');
      expect(actions.elements[0].style).toBe('primary');
    });

    it('ボタンの value に id と storySlug が JSON で埋め込まれる', () => {
      const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);
      const actions = blocks.find((b) => b.type === 'actions') as any;
      const parsed = JSON.parse(actions.elements[0].value);
      expect(parsed.id).toBe(id);
      expect(parsed.storySlug).toBe(storySlug);
    });
  });

  describe('一部FAILの場合', () => {
    const checkResult = {
      allPassed: false,
      conditions: [
        { condition: 'ログインAPIが動作する', passed: true, reason: 'テスト通過' },
        { condition: 'テストが通る', passed: false, reason: '2件のテストが失敗' },
      ],
    };

    it('section ブロックに一部 FAIL が含まれる', () => {
      const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);
      const section = blocks.find((b) => b.type === 'section') as any;
      expect(section.text.text).toContain('一部 FAIL');
      expect(section.text.text).toContain('⚠️');
    });

    it('PASS/FAILの詳細が表示される', () => {
      const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);
      const section = blocks.find((b) => b.type === 'section') as any;
      expect(section.text.text).toContain('✅ ログインAPIが動作する');
      expect(section.text.text).toContain('❌ テストが通る');
      expect(section.text.text).toContain('2件のテストが失敗');
    });

    it('「このまま Done にする」と「コメントして追加タスクを作る」ボタンが表示される', () => {
      const blocks = buildAcceptanceGateBlocks(id, storySlug, checkResult);
      const actions = blocks.find((b) => b.type === 'actions') as any;
      expect(actions).toBeDefined();
      expect(actions.elements).toHaveLength(2);

      const forceDoneBtn = actions.elements.find((e: any) => e.action_id === 'cwk_acceptance_force_done');
      expect(forceDoneBtn).toBeDefined();
      expect(forceDoneBtn.text.text).toBe('このまま Done にする');

      const commentBtn = actions.elements.find((e: any) => e.action_id === 'cwk_acceptance_comment');
      expect(commentBtn).toBeDefined();
      expect(commentBtn.text.text).toBe('コメントして追加タスクを作る');
      expect(commentBtn.style).toBe('primary');
    });
  });
});

describe('buildAcceptanceCommentModal', () => {
  it('モーダルの callback_id が cwk_acceptance_comment_modal である', () => {
    const modal = buildAcceptanceCommentModal('test-id', 'test-story');
    expect(modal.callback_id).toBe('cwk_acceptance_comment_modal');
  });

  it('private_metadata に id と storySlug が JSON で埋め込まれる', () => {
    const modal = buildAcceptanceCommentModal('test-id', 'test-story');
    const parsed = JSON.parse(modal.private_metadata!);
    expect(parsed.id).toBe('test-id');
    expect(parsed.storySlug).toBe('test-story');
  });

  it('テキスト入力ブロックが含まれる', () => {
    const modal = buildAcceptanceCommentModal('test-id', 'test-story');
    expect(modal.blocks).toHaveLength(1);
    const input = modal.blocks[0] as any;
    expect(input.type).toBe('input');
    expect(input.block_id).toBe('comment_block');
    expect(input.element.action_id).toBe('comment_input');
    expect(input.element.multiline).toBe(true);
  });

  it('送信・キャンセルボタンのラベルが正しい', () => {
    const modal = buildAcceptanceCommentModal('test-id', 'test-story');
    expect(modal.submit?.text).toBe('送信');
    expect(modal.close?.text).toBe('キャンセル');
  });
});

describe('buildQueueFailedBlocks', () => {
  const id = 'test-story--queue-failed--123';
  const storySlug = 'test-story';
  const message = '🚨 キューが停止しました\nStory: test-story が Failed になりました';

  it('section ブロックに通知メッセージが含まれる', () => {
    const blocks = buildQueueFailedBlocks(id, storySlug, message);
    const section = blocks.find((b) => b.type === 'section') as any;
    expect(section).toBeDefined();
    expect(section.text.text).toContain('キューが停止しました');
    expect(section.text.text).toContain(storySlug);
  });

  it('actions ブロックに3つのボタンが含まれる', () => {
    const blocks = buildQueueFailedBlocks(id, storySlug, message);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(3);
  });

  it('スキップして次へボタンの action_id が cwk_queue_resume である', () => {
    const blocks = buildQueueFailedBlocks(id, storySlug, message);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    const btn = actions.elements.find((e: any) => e.action_id === 'cwk_queue_resume');
    expect(btn).toBeDefined();
    expect(btn.text.text).toBe('スキップして次へ');
  });

  it('このStoryをリトライボタンの action_id が cwk_queue_retry である', () => {
    const blocks = buildQueueFailedBlocks(id, storySlug, message);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    const btn = actions.elements.find((e: any) => e.action_id === 'cwk_queue_retry');
    expect(btn).toBeDefined();
    expect(btn.text.text).toBe('このStoryをリトライ');
    expect(btn.style).toBe('primary');
  });

  it('キューをすべてクリアボタンの action_id が cwk_queue_clear である', () => {
    const blocks = buildQueueFailedBlocks(id, storySlug, message);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    const btn = actions.elements.find((e: any) => e.action_id === 'cwk_queue_clear');
    expect(btn).toBeDefined();
    expect(btn.text.text).toBe('キューをすべてクリア');
    expect(btn.style).toBe('danger');
  });

  it('ボタンの value に id と storySlug が JSON で埋め込まれる', () => {
    const blocks = buildQueueFailedBlocks(id, storySlug, message);
    const actions = blocks.find((b) => b.type === 'actions') as any;
    for (const element of actions.elements) {
      const parsed = JSON.parse(element.value);
      expect(parsed.id).toBe(id);
      expect(parsed.storySlug).toBe(storySlug);
    }
  });
});
