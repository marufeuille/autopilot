import { describe, it, expect, beforeEach } from 'vitest';
import {
  waitForRejection,
  signalRejection,
  cancelWaitForRejection,
  _resetForTest,
} from '../rejection-registry';

describe('RejectionRegistry', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('waitForRejection → signalRejection で reason が resolve される', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/1';
    const reason = 'テストが不十分です';

    const promise = waitForRejection(prUrl);
    signalRejection(prUrl, reason);

    await expect(promise).resolves.toBe(reason);
  });

  it('未登録の prUrl に対する signalRejection は false を返す', () => {
    const result = signalRejection('https://github.com/owner/repo/pull/999', '理由');
    expect(result).toBe(false);
  });

  it('signalRejection は登録済みの prUrl に対して true を返す', () => {
    const prUrl = 'https://github.com/owner/repo/pull/2';
    waitForRejection(prUrl);

    const result = signalRejection(prUrl, '設計が不適切');
    expect(result).toBe(true);
  });

  it('resolve 後に Map からエントリが削除される（再度 signalRejection は false）', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/3';

    const promise = waitForRejection(prUrl);
    signalRejection(prUrl, '修正が必要');
    await promise;

    const result = signalRejection(prUrl, '再送');
    expect(result).toBe(false);
  });

  it('異なる prUrl は独立して管理される', async () => {
    const prUrl1 = 'https://github.com/owner/repo/pull/10';
    const prUrl2 = 'https://github.com/owner/repo/pull/11';

    const promise1 = waitForRejection(prUrl1);
    const promise2 = waitForRejection(prUrl2);

    signalRejection(prUrl1, '理由A');
    signalRejection(prUrl2, '理由B');

    await expect(promise1).resolves.toBe('理由A');
    await expect(promise2).resolves.toBe('理由B');
  });

  it('cancelWaitForRejection でエントリが削除され signalRejection は false を返す', () => {
    const prUrl = 'https://github.com/owner/repo/pull/20';
    waitForRejection(prUrl);

    cancelWaitForRejection(prUrl);

    const result = signalRejection(prUrl, '遅延シグナル');
    expect(result).toBe(false);
  });

  it('cancelWaitForRejection は未登録の prUrl に対しても安全に呼べる', () => {
    // エラーが発生しないことを確認
    cancelWaitForRejection('https://github.com/owner/repo/pull/999');
  });

  // --- 新規テスト: Promise リーク防止 ---

  it('cancelWaitForRejection で Promise が完了する（pending のまま残らない）', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/25';
    const promise = waitForRejection(prUrl);

    cancelWaitForRejection(prUrl);

    // Promise が resolve されることを確認（pending のまま残らない）
    const result = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(result).toBe('resolved');
  });

  // --- 新規テスト: シグナルバッファリング ---

  it('signalRejection が waitForRejection より先に呼ばれた場合、シグナルがバッファリングされる', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/30';

    // 先にシグナルを送信（リスナー未登録）
    const result = signalRejection(prUrl, '先行シグナル');
    expect(result).toBe(false); // 即座に resolve されなかった

    // 後から waitForRejection を呼ぶとバッファされたシグナルが即座に resolve される
    const reason = await waitForRejection(prUrl);
    expect(reason).toBe('先行シグナル');
  });

  it('バッファされたシグナルは waitForRejection で消費後に削除される', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/31';

    signalRejection(prUrl, 'バッファ');
    await waitForRejection(prUrl); // 消費

    // 再度 waitForRejection を呼ぶと新しい Promise が作られる（バッファは空）
    // signalRejection で解決できることを確認
    const promise = waitForRejection(prUrl);
    signalRejection(prUrl, '新しいシグナル');
    await expect(promise).resolves.toBe('新しいシグナル');
  });
});
