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
    backend = new LocalNotificationBackend();
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

    it('c 入力で cancel を返す（buttons.cancel 指定時）', async () => {
      const mockRl = createMockReadline(['c']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval(
        'test-cancel-1',
        'テストメッセージ',
        { approve: '承認', reject: '却下', cancel: 'キャンセル' },
      );

      expect(result).toEqual({ action: 'cancel' });
      expect(mockRl.close).toHaveBeenCalled();
    });

    it('cancel 入力で cancel を返す（buttons.cancel 指定時）', async () => {
      const mockRl = createMockReadline(['cancel']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval(
        'test-cancel-2',
        'テストメッセージ',
        { approve: '承認', reject: '却下', cancel: 'キャンセル' },
      );

      expect(result).toEqual({ action: 'cancel' });
    });

    it('Cancel（大文字混在）入力で cancel を返す', async () => {
      const mockRl = createMockReadline(['Cancel']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval(
        'test-cancel-3',
        'テストメッセージ',
        { approve: '承認', reject: '却下', cancel: 'キャンセル' },
      );

      expect(result).toEqual({ action: 'cancel' });
    });

    it('C（大文字）入力で cancel を返す', async () => {
      const mockRl = createMockReadline(['C']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval(
        'test-cancel-4',
        'テストメッセージ',
        { approve: '承認', reject: '却下', cancel: 'キャンセル' },
      );

      expect(result).toEqual({ action: 'cancel' });
    });

    it('buttons.cancel 未指定時は c 入力で reject を返す', async () => {
      const mockRl = createMockReadline(['c', '']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestApproval(
        'test-cancel-5',
        'テストメッセージ',
        defaultButtons,
      );

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

    it('入力があるまで無制限に待機する（タイムアウトなし）', async () => {
      // question が呼ばれることを確認し、手動で応答する
      const mockRl = {
        question: vi.fn(),
        close: vi.fn(),
      } as unknown as ReadlineInterface;
      backend._createReadlineInterface = () => mockRl;

      const promise = backend.requestApproval(
        'wait-1',
        '待機テスト',
        defaultButtons,
      );

      // question が呼ばれたことを確認
      // notify は mockResolvedValue なので microtask をフラッシュ
      await new Promise((r) => setImmediate(r));
      expect(mockRl.question).toHaveBeenCalled();

      // 手動で応答を返す
      const callback = (mockRl.question as ReturnType<typeof vi.fn>).mock.calls[0][1];
      callback('y');

      const result = await promise;
      expect(result).toEqual({ action: 'approve' });
      expect(mockRl.close).toHaveBeenCalled();
    });
  });

  describe('requestTaskFailureAction', () => {
    it('y 入力（approve）で retry を返す', async () => {
      const mockRl = createMockReadline(['y']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestTaskFailureAction('task-01', 'story-01', 'error msg');
      expect(result).toBe('retry');
    });

    it('reject 入力で skip を返す', async () => {
      const mockRl = createMockReadline(['n', '']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestTaskFailureAction('task-01', 'story-01', 'error msg');
      expect(result).toBe('skip');
    });

    it('c 入力で cancel を返す', async () => {
      const mockRl = createMockReadline(['c']);
      backend._createReadlineInterface = () => mockRl;

      const result = await backend.requestTaskFailureAction('task-01', 'story-01', 'error msg');
      expect(result).toBe('cancel');
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
