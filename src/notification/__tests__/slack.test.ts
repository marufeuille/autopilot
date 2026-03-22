import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackNotificationBackend, registerApprovalHandlers } from '../slack';
import type { NotificationBackend, ApprovalResult } from '../types';

/**
 * Slack App のモックを作成する
 *
 * action / view コールバックをキャプチャし、テストから直接呼び出せるようにする。
 */
function createMockApp() {
  const actionHandlers = new Map<string, Function>();
  const viewHandlers = new Map<string, Function>();

  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
      },
      views: {
        open: vi.fn().mockResolvedValue({}),
      },
    },
    action: vi.fn((actionId: string, handler: Function) => {
      actionHandlers.set(actionId, handler);
    }),
    view: vi.fn(
      (
        idOrFilter: string | { callback_id: string; type: string },
        handler: Function,
      ) => {
        if (typeof idOrFilter === 'string') {
          viewHandlers.set(`submit:${idOrFilter}`, handler);
        } else {
          viewHandlers.set(`${idOrFilter.type}:${idOrFilter.callback_id}`, handler);
        }
      },
    ),
    start: vi.fn().mockResolvedValue(undefined),
    // テストヘルパー: 登録されたハンドラーを取得
    _actionHandlers: actionHandlers,
    _viewHandlers: viewHandlers,
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

describe('registerApprovalHandlers - 承認フロー', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let backend: SlackNotificationBackend;

  beforeEach(() => {
    mockApp = createMockApp();
    registerApprovalHandlers(mockApp);
    backend = new SlackNotificationBackend(mockApp);
  });

  it('ハンドラーが正しく登録される', () => {
    // action ハンドラー: cwk_approve, cwk_reject
    expect(mockApp.action).toHaveBeenCalledWith('cwk_approve', expect.any(Function));
    expect(mockApp.action).toHaveBeenCalledWith('cwk_reject', expect.any(Function));

    // view ハンドラー: cwk_reject_modal (submit), cwk_reject_modal (close)
    expect(mockApp.view).toHaveBeenCalledWith('cwk_reject_modal', expect.any(Function));
    expect(mockApp.view).toHaveBeenCalledWith(
      { callback_id: 'cwk_reject_modal', type: 'view_closed' },
      expect.any(Function),
    );
  });

  describe('approve ボタン押下', () => {
    it('approve ボタンで { action: "approve" } が返る', async () => {
      // 承認リクエストを投稿
      const approvalPromise = backend.requestApproval('approve-test', 'テスト', {
        approve: '開始',
        reject: 'スキップ',
      });

      // approve アクションハンドラーを直接呼び出す
      const approveHandler = mockApp._actionHandlers.get('cwk_approve');
      await approveHandler({
        ack: vi.fn(),
        body: {
          actions: [
            {
              value: 'approve-test',
              text: { type: 'plain_text', text: '開始' },
            },
          ],
        },
      });

      const result = await approvalPromise;
      expect(result).toEqual({ action: 'approve' });
    });

    it('approve 時にメッセージが更新される', async () => {
      const approvalPromise = backend.requestApproval('approve-msg-test', 'テスト', {
        approve: '承認',
        reject: '却下',
      });

      const approveHandler = mockApp._actionHandlers.get('cwk_approve');
      await approveHandler({
        ack: vi.fn(),
        body: {
          actions: [
            {
              value: 'approve-msg-test',
              text: { type: 'plain_text', text: '承認' },
            },
          ],
        },
      });

      await approvalPromise;

      // chat.update でメッセージが更新されている
      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: expect.any(String),
          ts: '1234567890.123456',
          text: '✅ 承認',
        }),
      );
    });
  });

  describe('reject ボタン → モーダル送信', () => {
    it('reject ボタン → モーダル入力で { action: "reject", reason: "..." } が返る', async () => {
      const approvalPromise = backend.requestApproval('reject-test', 'テスト', {
        approve: '開始',
        reject: 'スキップ',
      });

      // reject アクションハンドラーを呼び出す（モーダルを開く）
      const rejectHandler = mockApp._actionHandlers.get('cwk_reject');
      await rejectHandler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'reject-test' }],
          trigger_id: 'trigger-123',
        },
        client: {
          views: { open: vi.fn().mockResolvedValue({}) },
        },
      });

      // モーダル送信ハンドラーを呼び出す
      const viewSubmitHandler = mockApp._viewHandlers.get('submit:cwk_reject_modal');
      await viewSubmitHandler({
        ack: vi.fn(),
        view: {
          private_metadata: 'reject-test',
          state: {
            values: {
              reason_block: {
                reason_input: { value: 'バグが残っている' },
              },
            },
          },
        },
      });

      const result = await approvalPromise;
      expect(result).toEqual({ action: 'reject', reason: 'バグが残っている' });
    });

    it('reject 時にメッセージが「⏳ やり直し理由を入力中...」に更新される', async () => {
      const approvalPromise = backend.requestApproval('reject-msg-test', 'テスト', {
        approve: '開始',
        reject: 'スキップ',
      });

      const rejectHandler = mockApp._actionHandlers.get('cwk_reject');
      await rejectHandler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'reject-msg-test' }],
          trigger_id: 'trigger-456',
        },
        client: {
          views: { open: vi.fn().mockResolvedValue({}) },
        },
      });

      // 最初の update は「⏳ やり直し理由を入力中...」
      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '⏳ やり直し理由を入力中...',
        }),
      );

      // モーダル送信でクリーンアップ
      const viewSubmitHandler = mockApp._viewHandlers.get('submit:cwk_reject_modal');
      await viewSubmitHandler({
        ack: vi.fn(),
        view: {
          private_metadata: 'reject-msg-test',
          state: {
            values: {
              reason_block: {
                reason_input: { value: '修正が必要' },
              },
            },
          },
        },
      });

      await approvalPromise;

      // 2 回目の update は「🚫 やり直し: 修正が必要」
      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '🚫 やり直し: 修正が必要',
        }),
      );
    });

    it('reject 時にモーダルが開かれる', async () => {
      const approvalPromise = backend.requestApproval('reject-modal-test', 'テスト', {
        approve: '開始',
        reject: 'スキップ',
      });

      const mockViewsOpen = vi.fn().mockResolvedValue({});
      const rejectHandler = mockApp._actionHandlers.get('cwk_reject');
      await rejectHandler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'reject-modal-test' }],
          trigger_id: 'trigger-789',
        },
        client: {
          views: { open: mockViewsOpen },
        },
      });

      expect(mockViewsOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger-789',
          view: expect.objectContaining({
            type: 'modal',
            callback_id: 'cwk_reject_modal',
            notify_on_close: true,
            private_metadata: 'reject-modal-test',
          }),
        }),
      );

      // クリーンアップ
      const viewSubmitHandler = mockApp._viewHandlers.get('submit:cwk_reject_modal');
      await viewSubmitHandler({
        ack: vi.fn(),
        view: {
          private_metadata: 'reject-modal-test',
          state: {
            values: {
              reason_block: { reason_input: { value: '' } },
            },
          },
        },
      });
      await approvalPromise;
    });
  });

  describe('モーダル close（キャンセル）', () => {
    it('モーダル close 時に元のメッセージ（ボタン付き）が復元される', async () => {
      const approvalPromise = backend.requestApproval('close-test', 'テスト', {
        approve: '開始',
        reject: 'スキップ',
      });

      // reject ボタンでモーダルを開く
      const rejectHandler = mockApp._actionHandlers.get('cwk_reject');
      await rejectHandler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'close-test' }],
          trigger_id: 'trigger-close',
        },
        client: {
          views: { open: vi.fn().mockResolvedValue({}) },
        },
      });

      // chat.update のコールカウントをリセット（reject 時の更新分を除く）
      const updateCallsBefore = mockApp.client.chat.update.mock.calls.length;

      // モーダル close ハンドラーを呼び出す
      const viewCloseHandler = mockApp._viewHandlers.get('view_closed:cwk_reject_modal');
      await viewCloseHandler({
        ack: vi.fn(),
        view: {
          private_metadata: 'close-test',
        },
      });

      // 元のブロック（ボタン付き）が復元される
      const updateCallsAfter = mockApp.client.chat.update.mock.calls.length;
      expect(updateCallsAfter).toBe(updateCallsBefore + 1);

      const lastUpdateCall =
        mockApp.client.chat.update.mock.calls[updateCallsAfter - 1][0];
      expect(lastUpdateCall.channel).toBeDefined();
      expect(lastUpdateCall.ts).toBe('1234567890.123456');

      // 復元されたブロックにアクションボタンが含まれている
      const actionsBlock = lastUpdateCall.blocks.find(
        (b: any) => b.type === 'actions',
      );
      expect(actionsBlock).toBeDefined();
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].action_id).toBe('cwk_approve');
      expect(actionsBlock.elements[1].action_id).toBe('cwk_reject');

      // Promise はまだ pending（モーダル close は解決しない）
      // 再度 approve してクリーンアップ
      const approveHandler = mockApp._actionHandlers.get('cwk_approve');
      await approveHandler({
        ack: vi.fn(),
        body: {
          actions: [
            {
              value: 'close-test',
              text: { type: 'plain_text', text: '開始' },
            },
          ],
        },
      });

      const result = await approvalPromise;
      expect(result).toEqual({ action: 'approve' });
    });

    it('モーダル close 後にユーザーは再度承認/却下を選択できる', async () => {
      const approvalPromise = backend.requestApproval('close-retry-test', 'テスト', {
        approve: '開始',
        reject: 'スキップ',
      });

      // reject → モーダル close
      const rejectHandler = mockApp._actionHandlers.get('cwk_reject');
      await rejectHandler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'close-retry-test' }],
          trigger_id: 'trigger-close-retry',
        },
        client: {
          views: { open: vi.fn().mockResolvedValue({}) },
        },
      });

      const viewCloseHandler = mockApp._viewHandlers.get('view_closed:cwk_reject_modal');
      await viewCloseHandler({
        ack: vi.fn(),
        view: { private_metadata: 'close-retry-test' },
      });

      // close 後も pending のまま（resolve されていない）
      // 再度 reject → モーダル送信で解決する
      await rejectHandler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'close-retry-test' }],
          trigger_id: 'trigger-close-retry-2',
        },
        client: {
          views: { open: vi.fn().mockResolvedValue({}) },
        },
      });

      const viewSubmitHandler = mockApp._viewHandlers.get('submit:cwk_reject_modal');
      await viewSubmitHandler({
        ack: vi.fn(),
        view: {
          private_metadata: 'close-retry-test',
          state: {
            values: {
              reason_block: {
                reason_input: { value: 'やっぱりやり直し' },
              },
            },
          },
        },
      });

      const result = await approvalPromise;
      expect(result).toEqual({ action: 'reject', reason: 'やっぱりやり直し' });
    });
  });
});

describe('スレッド内投稿（thread_ts 対応）', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let backend: SlackNotificationBackend;

  beforeEach(() => {
    mockApp = createMockApp();
    backend = new SlackNotificationBackend(mockApp);
  });

  describe('startThread', () => {
    it('起点メッセージを投稿し thread_ts が保存される', async () => {
      mockApp.client.chat.postMessage.mockResolvedValueOnce({ ts: '1111111111.111111' });

      await backend.startThread('my-story', 'ストーリー開始');

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith({
        channel: expect.any(String),
        text: 'ストーリー開始',
      });
      expect(backend.getThreadTs('my-story')).toBe('1111111111.111111');
    });

    it('ts が返されない場合は thread_ts が保存されない', async () => {
      mockApp.client.chat.postMessage.mockResolvedValueOnce({});

      await backend.startThread('no-ts-story', 'メッセージ');

      expect(backend.getThreadTs('no-ts-story')).toBeUndefined();
    });
  });

  describe('notify with storySlug', () => {
    it('storySlug を渡すとスレッド返信になる', async () => {
      // スレッドを開始
      mockApp.client.chat.postMessage.mockResolvedValueOnce({ ts: '2222222222.222222' });
      await backend.startThread('threaded-story', '起点メッセージ');

      // スレッド内に通知
      await backend.notify('スレッド内通知', 'threaded-story');

      const lastCall = mockApp.client.chat.postMessage.mock.calls[1][0];
      expect(lastCall).toEqual({
        channel: expect.any(String),
        text: 'スレッド内通知',
        thread_ts: '2222222222.222222',
      });
    });

    it('storySlug 省略時は従来のチャンネル直投稿が維持される', async () => {
      await backend.notify('チャンネル直投稿');

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith({
        channel: expect.any(String),
        text: 'チャンネル直投稿',
      });
      // thread_ts が含まれていないことを確認
      const callArgs = mockApp.client.chat.postMessage.mock.calls[0][0];
      expect(callArgs.thread_ts).toBeUndefined();
    });

    it('未登録の storySlug を渡した場合はチャンネル直投稿にフォールバックする', async () => {
      await backend.notify('フォールバック通知', 'unknown-story');

      const callArgs = mockApp.client.chat.postMessage.mock.calls[0][0];
      expect(callArgs.thread_ts).toBeUndefined();
      expect(callArgs.text).toBe('フォールバック通知');
    });
  });

  describe('requestApproval with storySlug', () => {
    it('storySlug を渡すとスレッド内に承認ボタンが投稿される', async () => {
      // スレッドを開始
      mockApp.client.chat.postMessage.mockResolvedValueOnce({ ts: '3333333333.333333' });
      await backend.startThread('approval-story', '起点メッセージ');

      // スレッド内に承認リクエスト
      const promise = backend.requestApproval(
        'thread-approval-id',
        '承認してください',
        { approve: '承認', reject: '却下' },
        'approval-story',
      );

      const lastCall = mockApp.client.chat.postMessage.mock.calls[1][0];
      expect(lastCall.thread_ts).toBe('3333333333.333333');
      expect(lastCall.blocks).toBeDefined();

      void promise;
    });

    it('storySlug 省略時は従来のチャンネル直投稿が維持される', async () => {
      const promise = backend.requestApproval(
        'no-thread-id',
        '承認してください',
        { approve: '承認', reject: '却下' },
      );

      const callArgs = mockApp.client.chat.postMessage.mock.calls[0][0];
      expect(callArgs.thread_ts).toBeUndefined();
      expect(callArgs.blocks).toBeDefined();

      void promise;
    });
  });

  describe('複数ストーリーの分離', () => {
    it('異なるストーリーはそれぞれ別スレッドに分離される', async () => {
      // ストーリーA のスレッド開始
      mockApp.client.chat.postMessage.mockResolvedValueOnce({ ts: 'ts-story-a' });
      await backend.startThread('story-a', 'ストーリーA開始');

      // ストーリーB のスレッド開始
      mockApp.client.chat.postMessage.mockResolvedValueOnce({ ts: 'ts-story-b' });
      await backend.startThread('story-b', 'ストーリーB開始');

      // ストーリーA に通知
      await backend.notify('A向け通知', 'story-a');
      const callA = mockApp.client.chat.postMessage.mock.calls[2][0];
      expect(callA.thread_ts).toBe('ts-story-a');

      // ストーリーB に通知
      await backend.notify('B向け通知', 'story-b');
      const callB = mockApp.client.chat.postMessage.mock.calls[3][0];
      expect(callB.thread_ts).toBe('ts-story-b');
    });
  });
});
