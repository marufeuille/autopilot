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

  it('イベントにタイムスタンプが記録される', async () => {
    const notifier = new FakeNotifier();

    await notifier.notify('test');

    expect(notifier.notifications[0].timestamp).toBeInstanceOf(Date);
  });
});
