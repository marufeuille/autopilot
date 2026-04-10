import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NtfyNotificationBackend } from '../ntfy';

describe('NtfyNotificationBackend', () => {
  let backend: NtfyNotificationBackend;

  beforeEach(() => {
    backend = new NtfyNotificationBackend('https://ntfy.sh', 'test-topic');
    vi.restoreAllMocks();
  });

  describe('notify()', () => {
    it('ntfy.sh に POST リクエストを送信する', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });
      vi.stubGlobal('fetch', mockFetch);

      await backend.notify('テスト通知メッセージ');

      expect(mockFetch).toHaveBeenCalledWith('https://ntfy.sh/test-topic', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-Title': 'Autopilot',
        },
        body: 'テスト通知メッセージ',
      });
    });

    it('サーバー URL の末尾スラッシュを除去する', async () => {
      const backendWithSlash = new NtfyNotificationBackend(
        'https://ntfy.sh/',
        'test-topic',
      );
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });
      vi.stubGlobal('fetch', mockFetch);

      await backendWithSlash.notify('test');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.sh/test-topic',
        expect.any(Object),
      );
    });

    it('HTTP エラー時に例外をスローする', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(backend.notify('test')).rejects.toThrow(/403/);
    });

    it('セルフホストサーバーの URL を使用できる', async () => {
      const selfHosted = new NtfyNotificationBackend(
        'https://my-ntfy.example.com',
        'my-topic',
      );
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });
      vi.stubGlobal('fetch', mockFetch);

      await selfHosted.notify('hello');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://my-ntfy.example.com/my-topic',
        expect.any(Object),
      );
    });
  });

  describe('requestApproval()', () => {
    it('未実装のためエラーをスローする', async () => {
      await expect(
        backend.requestApproval('id-1', 'msg', {
          approve: 'OK',
          reject: 'NG',
        }),
      ).rejects.toThrow(/requestApproval.*not yet implemented/);
    });
  });
});
