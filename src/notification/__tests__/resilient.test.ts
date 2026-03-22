import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResilientNotificationBackend } from '../resilient';
import type { NotificationBackend, ApprovalResult } from '../types';

function createMockBackend(overrides: Partial<NotificationBackend> = {}): NotificationBackend {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    requestApproval: vi.fn().mockResolvedValue({ action: 'approve' } as ApprovalResult),
    startThread: vi.fn().mockResolvedValue(undefined),
    getThreadTs: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

/** sleep をスキップするテスト用サブクラス */
class TestResilientBackend extends ResilientNotificationBackend {
  protected override sleep(_ms: number): Promise<void> {
    return Promise.resolve();
  }
}

describe('ResilientNotificationBackend', () => {
  let primary: NotificationBackend;
  let fallback: NotificationBackend;

  beforeEach(() => {
    primary = createMockBackend();
    fallback = createMockBackend();
  });

  describe('notify', () => {
    it('プライマリが成功すればプライマリ経由で送信される', async () => {
      const resilient = new TestResilientBackend(primary, { fallback });

      await resilient.notify('テストメッセージ');

      expect(primary.notify).toHaveBeenCalledWith('テストメッセージ', undefined);
      expect(fallback.notify).not.toHaveBeenCalled();
    });

    it('プライマリが失敗するとリトライされる', async () => {
      const mockNotify = vi.fn()
        .mockRejectedValueOnce(new Error('Slack error'))
        .mockResolvedValueOnce(undefined);
      primary = createMockBackend({ notify: mockNotify });
      const resilient = new TestResilientBackend(primary, { fallback, maxRetries: 2 });

      await resilient.notify('テスト');

      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(fallback.notify).not.toHaveBeenCalled();
    });

    it('リトライ上限到達でフォールバックに切り替わる', async () => {
      const mockNotify = vi.fn().mockRejectedValue(new Error('Slack error'));
      primary = createMockBackend({ notify: mockNotify });
      const resilient = new TestResilientBackend(primary, { fallback, maxRetries: 1 });

      await resilient.notify('フォールバックテスト');

      expect(mockNotify).toHaveBeenCalledTimes(2); // 1 + 1 retry
      expect(fallback.notify).toHaveBeenCalledWith('フォールバックテスト', undefined);
    });

    it('maxRetries=0 の場合は即座にフォールバックする', async () => {
      const mockNotify = vi.fn().mockRejectedValue(new Error('error'));
      primary = createMockBackend({ notify: mockNotify });
      const resilient = new TestResilientBackend(primary, { fallback, maxRetries: 0 });

      await resilient.notify('即フォールバック');

      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(fallback.notify).toHaveBeenCalledWith('即フォールバック', undefined);
    });
  });

  describe('requestApproval', () => {
    it('プライマリが成功すればプライマリ経由で承認リクエストされる', async () => {
      const resilient = new TestResilientBackend(primary, { fallback });

      const result = await resilient.requestApproval('id-1', 'メッセージ', {
        approve: '承認',
        reject: '却下',
      });

      expect(result).toEqual({ action: 'approve' });
      expect(primary.requestApproval).toHaveBeenCalledWith('id-1', 'メッセージ', {
        approve: '承認',
        reject: '却下',
      }, undefined);
      expect(fallback.requestApproval).not.toHaveBeenCalled();
    });

    it('プライマリが失敗するとフォールバックに切り替わる', async () => {
      const mockApproval = vi.fn().mockRejectedValue(new Error('Slack error'));
      primary = createMockBackend({ requestApproval: mockApproval });
      const mockFallbackApproval = vi.fn().mockResolvedValue({ action: 'reject', reason: 'test' });
      fallback = createMockBackend({ requestApproval: mockFallbackApproval });
      const resilient = new TestResilientBackend(primary, { fallback, maxRetries: 0 });

      const result = await resilient.requestApproval('id-2', 'メッセージ', {
        approve: '承認',
        reject: '却下',
      });

      expect(result).toEqual({ action: 'reject', reason: 'test' });
      expect(mockFallbackApproval).toHaveBeenCalled();
    });

    it('リトライ後に成功すればフォールバックは使われない', async () => {
      const mockApproval = vi.fn()
        .mockRejectedValueOnce(new Error('temporary error'))
        .mockResolvedValueOnce({ action: 'approve' });
      primary = createMockBackend({ requestApproval: mockApproval });
      const resilient = new TestResilientBackend(primary, { fallback, maxRetries: 1 });

      const result = await resilient.requestApproval('id-3', 'メッセージ', {
        approve: '承認',
        reject: '却下',
      });

      expect(result).toEqual({ action: 'approve' });
      expect(mockApproval).toHaveBeenCalledTimes(2);
      expect(fallback.requestApproval).not.toHaveBeenCalled();
    });
  });

  describe('デフォルト設定', () => {
    it('フォールバック未指定時は LocalNotificationBackend がデフォルト', async () => {
      const { LocalNotificationBackend } = await import('../local');
      const resilient = new ResilientNotificationBackend(primary);

      // 内部プロパティは直接アクセスできないが、プライマリが失敗した時に
      // LocalNotificationBackend のフォールバック動作を確認する
      const mockNotify = vi.fn().mockRejectedValue(new Error('fail'));
      primary = createMockBackend({ notify: mockNotify });
      const resilientWithFail = new TestResilientBackend(primary, { maxRetries: 0 });

      // notify がエラーにならなければフォールバックが動作している
      await expect(resilientWithFail.notify('test')).resolves.toBeUndefined();
    });
  });
});
