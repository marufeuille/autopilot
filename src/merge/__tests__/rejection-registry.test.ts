import { describe, it, expect } from 'vitest';
import { waitForRejection, signalRejection } from '../rejection-registry';

describe('RejectionRegistry', () => {
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
});
