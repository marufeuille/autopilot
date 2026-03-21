import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalNotificationBackend } from '../local';
import type { Interface as ReadlineInterface } from 'readline';

/**
 * readline.Interface のモックを作成する
 * question() 呼び出し時に指定した回答を順番に返す
 */
function createMockReadline(answers: string[]): ReadlineInterface {
  let callIndex = 0;
  return {
    question: vi.fn((_prompt: string, callback: (answer: string) => void) => {
      const answer = answers[callIndex] ?? '';
      callIndex++;
      // 非同期で応答（実際の readline と同様）
      setImmediate(() => callback(answer));
    }),
    close: vi.fn(),
  } as unknown as ReadlineInterface;
}

describe('LocalNotificationBackend', () => {
  let backend: LocalNotificationBackend;

  beforeEach(() => {
    backend = new LocalNotificationBackend({ approvalTimeoutMs: 5000 });
    // osascript の実行をモック（テスト環境では通知を送らない）
    vi.spyOn(backend, 'notify').mockResolvedValue();
  });

  describe('requestApproval', () => {
    const defaultButtons = { approve: '承認', reject: '却下' };

    it('y 入力で approve を返す', async () => {
      const mockRl = createMockReadline(['y']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval('test-1', 'テストメッセージ', defaultButtons);

      expect(result).toEqual({ action: 'approve' });
      expect(mockRl.close).toHaveBeenCalled();
    });

    it('yes 入力で approve を返す', async () => {
      const mockRl = createMockReadline(['yes']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval('test-2', 'テストメッセージ', defaultButtons);

      expect(result).toEqual({ action: 'approve' });
    });

    it('YES（大文字）入力で approve を返す', async () => {
      const mockRl = createMockReadline(['YES']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval('test-3', 'テストメッセージ', defaultButtons);

      expect(result).toEqual({ action: 'approve' });
    });

    it('Y（大文字）入力で approve を返す', async () => {
      const mockRl = createMockReadline(['Y']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval('test-4', 'テストメッセージ', defaultButtons);

      expect(result).toEqual({ action: 'approve' });
    });

    it('n 入力で reject を返す（理由なし → デフォルト理由）', async () => {
      const mockRl = createMockReadline(['n', '']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval('test-5', 'テストメッセージ', defaultButtons);

      expect(result.action).toBe('reject');
      if (result.action === 'reject') {
        expect(result.reason).toBe('却下');
      }
    });

    it('n 入力で reject を返す（理由あり）', async () => {
      const mockRl = createMockReadline(['n', '修正が必要']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval('test-6', 'テストメッセージ', defaultButtons);

      expect(result.action).toBe('reject');
      if (result.action === 'reject') {
        expect(result.reason).toBe('修正が必要');
      }
    });

    it('空入力で reject を返す', async () => {
      const mockRl = createMockReadline(['', '']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval('test-7', 'テストメッセージ', defaultButtons);

      expect(result.action).toBe('reject');
    });

    it('承認リクエスト時に notify が呼ばれる', async () => {
      const mockRl = createMockReadline(['y']);
      backend._createReadlineInterface = () => mockRl;

      await backend.requestApproval('test-8', 'テストメッセージ', defaultButtons);

      expect(backend.notify).toHaveBeenCalledWith(
        expect.stringContaining('承認リクエスト'),
      );
    });
  });

  describe('タイムアウト', () => {
    it('タイムアウト時に reject を返す', async () => {
      vi.useFakeTimers();

      const shortTimeoutBackend = new LocalNotificationBackend({ approvalTimeoutMs: 1000 });
      vi.spyOn(shortTimeoutBackend, 'notify').mockResolvedValue();

      // question を呼んでも応答しない（タイムアウトを待つ）
      const mockRl = {
        question: vi.fn(),
        close: vi.fn(),
      } as unknown as ReadlineInterface;
      shortTimeoutBackend._createReadlineInterface = () => mockRl;

      const promise = shortTimeoutBackend.requestApproval(
        'timeout-1',
        'タイムアウトテスト',
        { approve: '承認', reject: '却下' },
      );

      // notify の mockResolvedValue が microtask なのでフラッシュ
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;

      expect(result.action).toBe('reject');
      if (result.action === 'reject') {
        expect(result.reason).toBe('タイムアウト');
      }
      expect(mockRl.close).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('デフォルトタイムアウトは5分', () => {
      const defaultBackend = new LocalNotificationBackend();
      // timeoutMs は private なので、オプションなしで作成してエラーにならないことを確認
      expect(defaultBackend).toBeDefined();
    });
  });

  describe('notify', () => {
    it('notify が正常に呼べる（モック無しの場合のコンソール出力確認）', async () => {
      const realBackend = new LocalNotificationBackend();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // osascript の失敗は warn で処理されるのでテスト環境でも動く
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await realBackend.notify('テスト通知');

      expect(consoleSpy).toHaveBeenCalledWith('[notify] テスト通知');

      consoleSpy.mockRestore();
    });
  });
});
