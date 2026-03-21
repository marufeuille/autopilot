import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackNotificationBackend } from '../slack';
import type { NotificationBackend } from '../types';

/**
 * Slack App のモックを作成する
 */
function createMockApp() {
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    action: vi.fn(),
    view: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('SlackNotificationBackend', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let backend: SlackNotificationBackend;

  beforeEach(() => {
    mockApp = createMockApp();
    backend = new SlackNotificationBackend(mockApp);
  });

  describe('NotificationBackend インターフェース準拠', () => {
    it('NotificationBackend インターフェースの必須メソッドを持つ', () => {
      const notifier: NotificationBackend = backend;
      expect(typeof notifier.notify).toBe('function');
      expect(typeof notifier.requestApproval).toBe('function');
    });

    it('notify が Promise<void> を返す', async () => {
      const result = backend.notify('テスト');
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });

    it('requestApproval が Promise<ApprovalResult> を返す', () => {
      const result = backend.requestApproval('id-1', 'メッセージ', {
        approve: '承認',
        reject: '却下',
      });
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('notify', () => {
    it('Slack チャンネルにメッセージを送信する', async () => {
      await backend.notify('テスト通知メッセージ');

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith({
        channel: expect.any(String),
        text: 'テスト通知メッセージ',
      });
    });

    it('複数回呼び出しても毎回送信される', async () => {
      await backend.notify('メッセージ1');
      await backend.notify('メッセージ2');

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('requestApproval', () => {
    it('承認ブロック付きメッセージを Slack に投稿する', async () => {
      // requestApproval は承認待ちの Promise を返すので、投稿だけ確認する
      const promise = backend.requestApproval('test-id', 'テストメッセージ', {
        approve: '開始',
        reject: 'スキップ',
      });

      // postMessage が呼ばれたことを確認
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith({
        channel: expect.any(String),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'section',
            text: { type: 'mrkdwn', text: 'テストメッセージ' },
          }),
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'cwk_approve',
                text: { type: 'plain_text', text: '開始' },
                value: 'test-id',
              }),
              expect.objectContaining({
                action_id: 'cwk_reject',
                text: { type: 'plain_text', text: 'スキップ' },
                value: 'test-id',
              }),
            ]),
          }),
        ]),
      });

      // Promise は pending なのでクリーンアップ（テストがハングしないように）
      // 注: 実際の解決はアクションハンドラ経由で行われる
      void promise;
    });

    it('承認ボタンのラベルが正しく設定される', async () => {
      const promise = backend.requestApproval('test-id-2', 'メッセージ', {
        approve: '完了',
        reject: 'やり直し',
      });

      const callArgs = mockApp.client.chat.postMessage.mock.calls[0][0];
      const actions = callArgs.blocks.find((b: any) => b.type === 'actions');
      const approveBtn = actions.elements.find((e: any) => e.action_id === 'cwk_approve');
      const rejectBtn = actions.elements.find((e: any) => e.action_id === 'cwk_reject');

      expect(approveBtn.text.text).toBe('完了');
      expect(rejectBtn.text.text).toBe('やり直し');

      void promise;
    });
  });
});
