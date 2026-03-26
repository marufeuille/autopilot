import { describe, it, expect } from 'vitest';
import { FakeNotifier } from './fake-notifier';

describe('FakeNotifier', () => {
  it('notify でメッセージを記録する', async () => {
    const notifier = new FakeNotifier();

    await notifier.notify('Task started');
    await notifier.notify('Task completed');

    expect(notifier.notifications).toHaveLength(2);
    expect(notifier.notifications[0].message).toBe('Task started');
    expect(notifier.notifications[1].message).toBe('Task completed');
  });

  it('notify のイベントが events にも記録される', async () => {
    const notifier = new FakeNotifier();

    await notifier.notify('hello');

    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0].type).toBe('notify');
  });

  it('requestApproval でデフォルトは approve を返す', async () => {
    const notifier = new FakeNotifier();

    const result = await notifier.requestApproval(
      'approval-1',
      'Merge this PR?',
      { approve: 'Merge', reject: 'Reject' },
    );

    expect(result).toEqual({ action: 'approve' });
  });

  it('requestApproval の呼び出しが記録される', async () => {
    const notifier = new FakeNotifier();

    await notifier.requestApproval(
      'approval-1',
      'Merge this PR?',
      { approve: 'Merge', reject: 'Reject' },
    );

    expect(notifier.approvalRequests).toHaveLength(1);
    expect(notifier.approvalRequests[0].id).toBe('approval-1');
    expect(notifier.approvalRequests[0].message).toBe('Merge this PR?');
    expect(notifier.approvalRequests[0].response).toEqual({ action: 'approve' });
  });

  it('応答キューから順に応答を返す', async () => {
    const notifier = new FakeNotifier({
      approvalResponses: [
        { action: 'reject', reason: 'Not ready yet' },
        { action: 'approve' },
      ],
    });

    const result1 = await notifier.requestApproval('id-1', 'msg', {
      approve: 'OK',
      reject: 'NG',
    });
    const result2 = await notifier.requestApproval('id-2', 'msg', {
      approve: 'OK',
      reject: 'NG',
    });
    // キューが空になった後はデフォルト approve
    const result3 = await notifier.requestApproval('id-3', 'msg', {
      approve: 'OK',
      reject: 'NG',
    });

    expect(result1).toEqual({ action: 'reject', reason: 'Not ready yet' });
    expect(result2).toEqual({ action: 'approve' });
    expect(result3).toEqual({ action: 'approve' });
  });

  it('enqueueApprovalResponse でキューに追加できる', async () => {
    const notifier = new FakeNotifier();

    notifier.enqueueApprovalResponse(
      { action: 'reject', reason: 'first reject' },
      { action: 'approve' },
    );

    const result1 = await notifier.requestApproval('id-1', 'msg', {
      approve: 'OK',
      reject: 'NG',
    });
    const result2 = await notifier.requestApproval('id-2', 'msg', {
      approve: 'OK',
      reject: 'NG',
    });

    expect(result1).toEqual({ action: 'reject', reason: 'first reject' });
    expect(result2).toEqual({ action: 'approve' });
  });

  it('notify と requestApproval のイベントが時系列で events に記録される', async () => {
    const notifier = new FakeNotifier();

    await notifier.notify('Starting task');
    await notifier.requestApproval('id-1', 'Approve?', {
      approve: 'Yes',
      reject: 'No',
    });
    await notifier.notify('Task done');

    expect(notifier.events).toHaveLength(3);
    expect(notifier.events[0].type).toBe('notify');
    expect(notifier.events[1].type).toBe('requestApproval');
    expect(notifier.events[2].type).toBe('notify');
  });

  it('reset ですべての記録をクリアできる', async () => {
    const notifier = new FakeNotifier({
      approvalResponses: [{ action: 'reject', reason: 'no' }],
    });

    await notifier.notify('hello');
    await notifier.requestApproval('id', 'msg', {
      approve: 'OK',
      reject: 'NG',
    });

    notifier.reset();

    expect(notifier.events).toHaveLength(0);
    expect(notifier.notifications).toHaveLength(0);
    expect(notifier.approvalRequests).toHaveLength(0);

    // キューもリセットされるのでデフォルト approve
    const result = await notifier.requestApproval('id', 'msg', {
      approve: 'OK',
      reject: 'NG',
    });
    expect(result).toEqual({ action: 'approve' });
  });

  it('requestTaskFailureAction でデフォルトは retry を返す', async () => {
    const notifier = new FakeNotifier();
    const result = await notifier.requestTaskFailureAction('task-01', 'story-01', 'error');
    expect(result).toBe('retry');
  });

  it('requestTaskFailureAction の呼び出しが記録される', async () => {
    const notifier = new FakeNotifier();
    await notifier.requestTaskFailureAction('task-01', 'story-01', 'error msg');

    expect(notifier.taskFailureRequests).toHaveLength(1);
    expect(notifier.taskFailureRequests[0].taskSlug).toBe('task-01');
    expect(notifier.taskFailureRequests[0].storySlug).toBe('story-01');
    expect(notifier.taskFailureRequests[0].errorSummary).toBe('error msg');
    expect(notifier.taskFailureRequests[0].response).toBe('retry');
  });

  it('taskFailureResponses キューから順に応答を返す', async () => {
    const notifier = new FakeNotifier({
      taskFailureResponses: ['skip', 'cancel'],
    });

    const result1 = await notifier.requestTaskFailureAction('t1', 's1', 'e1');
    const result2 = await notifier.requestTaskFailureAction('t2', 's1', 'e2');
    const result3 = await notifier.requestTaskFailureAction('t3', 's1', 'e3');

    expect(result1).toBe('skip');
    expect(result2).toBe('cancel');
    expect(result3).toBe('retry'); // default
  });

  it('enqueueTaskFailureResponse でキューに追加できる', async () => {
    const notifier = new FakeNotifier();
    notifier.enqueueTaskFailureResponse('cancel', 'skip');

    const result1 = await notifier.requestTaskFailureAction('t1', 's1', 'e1');
    const result2 = await notifier.requestTaskFailureAction('t2', 's1', 'e2');
    expect(result1).toBe('cancel');
    expect(result2).toBe('skip');
  });

  it('イベントにタイムスタンプが記録される', async () => {
    const notifier = new FakeNotifier();

    await notifier.notify('test');

    expect(notifier.notifications[0].timestamp).toBeInstanceOf(Date);
  });

  it('requestAcceptanceGateAction でデフォルトは done を返す', async () => {
    const notifier = new FakeNotifier();
    const result = await notifier.requestAcceptanceGateAction('story-01', {
      allPassed: true,
      conditions: [{ condition: 'テスト通過', passed: true, reason: 'OK' }],
    });
    expect(result).toEqual({ action: 'done' });
  });

  it('requestAcceptanceGateAction の呼び出しが記録される', async () => {
    const notifier = new FakeNotifier();
    const checkResult = {
      allPassed: false,
      conditions: [{ condition: 'テスト', passed: false, reason: '失敗' }],
    };
    await notifier.requestAcceptanceGateAction('story-01', checkResult);

    expect(notifier.acceptanceGateRequests).toHaveLength(1);
    expect(notifier.acceptanceGateRequests[0].storySlug).toBe('story-01');
    expect(notifier.acceptanceGateRequests[0].checkResult).toBe(checkResult);
    expect(notifier.acceptanceGateRequests[0].response).toEqual({ action: 'done' });
  });

  it('acceptanceGateResponses キューから順に応答を返す', async () => {
    const notifier = new FakeNotifier({
      acceptanceGateResponses: [
        { action: 'force_done' },
        { action: 'comment', text: '修正が必要' },
      ],
    });

    const result1 = await notifier.requestAcceptanceGateAction('s1', { allPassed: false, conditions: [] });
    const result2 = await notifier.requestAcceptanceGateAction('s1', { allPassed: false, conditions: [] });
    const result3 = await notifier.requestAcceptanceGateAction('s1', { allPassed: true, conditions: [] });

    expect(result1).toEqual({ action: 'force_done' });
    expect(result2).toEqual({ action: 'comment', text: '修正が必要' });
    expect(result3).toEqual({ action: 'done' }); // default
  });

  it('enqueueAcceptanceGateResponse でキューに追加できる', async () => {
    const notifier = new FakeNotifier();
    notifier.enqueueAcceptanceGateResponse(
      { action: 'comment', text: 'テスト' },
      { action: 'force_done' },
    );

    const result1 = await notifier.requestAcceptanceGateAction('s1', { allPassed: false, conditions: [] });
    const result2 = await notifier.requestAcceptanceGateAction('s1', { allPassed: false, conditions: [] });

    expect(result1).toEqual({ action: 'comment', text: 'テスト' });
    expect(result2).toEqual({ action: 'force_done' });
  });

  it('reset で acceptanceGateRequests もクリアされる', async () => {
    const notifier = new FakeNotifier({
      acceptanceGateResponses: [{ action: 'force_done' }],
    });
    await notifier.requestAcceptanceGateAction('s1', { allPassed: false, conditions: [] });

    notifier.reset();

    expect(notifier.acceptanceGateRequests).toHaveLength(0);
    // キューもリセットされるのでデフォルト done
    const result = await notifier.requestAcceptanceGateAction('s1', { allPassed: true, conditions: [] });
    expect(result).toEqual({ action: 'done' });
  });
});
