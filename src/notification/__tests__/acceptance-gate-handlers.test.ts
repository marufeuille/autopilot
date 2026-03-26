import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAcceptanceGateHandlers, SlackNotificationBackend } from '../slack';
import type { AcceptanceCheckResult } from '../types';

/**
 * Slack App のモックを作成する
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
    _actionHandlers: actionHandlers,
    _viewHandlers: viewHandlers,
  } as any;
}

describe('registerAcceptanceGateHandlers', () => {
  let mockApp: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    mockApp = createMockApp();
    registerAcceptanceGateHandlers(mockApp);
  });

  it('4つのハンドラーが登録される（3 action + 1 view submit + 1 view_closed）', () => {
    // action: cwk_acceptance_done, cwk_acceptance_force_done, cwk_acceptance_comment
    expect(mockApp.action).toHaveBeenCalledTimes(3);
    // view: cwk_acceptance_comment_modal (submit) + cwk_acceptance_comment_modal (view_closed)
    expect(mockApp.view).toHaveBeenCalledTimes(2);
  });

  it('cwk_acceptance_done ハンドラーが登録される', () => {
    expect(mockApp._actionHandlers.has('cwk_acceptance_done')).toBe(true);
  });

  it('cwk_acceptance_force_done ハンドラーが登録される', () => {
    expect(mockApp._actionHandlers.has('cwk_acceptance_force_done')).toBe(true);
  });

  it('cwk_acceptance_comment ハンドラーが登録される', () => {
    expect(mockApp._actionHandlers.has('cwk_acceptance_comment')).toBe(true);
  });

  it('cwk_acceptance_comment_modal submit ハンドラーが登録される', () => {
    expect(mockApp._viewHandlers.has('submit:cwk_acceptance_comment_modal')).toBe(true);
  });

  it('cwk_acceptance_comment_modal view_closed ハンドラーが登録される', () => {
    expect(mockApp._viewHandlers.has('view_closed:cwk_acceptance_comment_modal')).toBe(true);
  });
});

describe('SlackNotificationBackend.requestAcceptanceGateAction', () => {
  let mockApp: ReturnType<typeof createMockApp>;
  let backend: SlackNotificationBackend;

  beforeEach(() => {
    mockApp = createMockApp();
    backend = new SlackNotificationBackend(mockApp);
    registerAcceptanceGateHandlers(mockApp);
  });

  const allPassResult: AcceptanceCheckResult = {
    allPassed: true,
    conditions: [
      { condition: 'テストが通る', passed: true, reason: '全テスト通過' },
    ],
  };

  const partialFailResult: AcceptanceCheckResult = {
    allPassed: false,
    conditions: [
      { condition: 'テストが通る', passed: true, reason: '全テスト通過' },
      { condition: 'APIが動作する', passed: false, reason: 'エンドポイント未実装' },
    ],
  };

  it('Slack にチェック結果メッセージを投稿する', async () => {
    const promise = backend.requestAcceptanceGateAction('my-story', allPassResult);

    // postMessage が呼ばれるまで待つ
    await vi.waitFor(() => {
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    const call = mockApp.client.chat.postMessage.mock.calls[0][0];
    expect(call.text).toContain('my-story');
    expect(call.blocks).toBeDefined();
    expect(call.blocks.length).toBeGreaterThan(0);

    // Promise が pending であることを確認（ユーザーアクション待ち）
    // cleanup: done ハンドラーを呼んで resolve する
    const doneHandler = mockApp._actionHandlers.get('cwk_acceptance_done');
    const metadata = JSON.parse(call.blocks[1].elements[0].value);
    await doneHandler({
      body: { actions: [{ value: JSON.stringify(metadata) }] },
      ack: vi.fn(),
    });

    const result = await promise;
    expect(result).toEqual({ action: 'done' });
  });

  it('cwk_acceptance_done で done を返す', async () => {
    const promise = backend.requestAcceptanceGateAction('my-story', allPassResult);

    await vi.waitFor(() => {
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    const call = mockApp.client.chat.postMessage.mock.calls[0][0];
    const metadata = JSON.parse(call.blocks[1].elements[0].value);
    const handler = mockApp._actionHandlers.get('cwk_acceptance_done');

    await handler({
      body: { actions: [{ value: JSON.stringify(metadata) }] },
      ack: vi.fn(),
    });

    const result = await promise;
    expect(result).toEqual({ action: 'done' });
  });

  it('cwk_acceptance_force_done で force_done を返す', async () => {
    const promise = backend.requestAcceptanceGateAction('my-story', partialFailResult);

    await vi.waitFor(() => {
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    const call = mockApp.client.chat.postMessage.mock.calls[0][0];
    const forceDoneBtn = call.blocks[1].elements.find((e: any) => e.action_id === 'cwk_acceptance_force_done');
    const metadata = JSON.parse(forceDoneBtn.value);
    const handler = mockApp._actionHandlers.get('cwk_acceptance_force_done');

    await handler({
      body: { actions: [{ value: JSON.stringify(metadata) }] },
      ack: vi.fn(),
    });

    const result = await promise;
    expect(result).toEqual({ action: 'force_done' });
  });

  it('cwk_acceptance_comment → モーダル送信で comment を返す', async () => {
    const promise = backend.requestAcceptanceGateAction('my-story', partialFailResult);

    await vi.waitFor(() => {
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledTimes(1);
    });

    const call = mockApp.client.chat.postMessage.mock.calls[0][0];
    const commentBtn = call.blocks[1].elements.find((e: any) => e.action_id === 'cwk_acceptance_comment');
    const metadata = JSON.parse(commentBtn.value);

    // コメントボタン押下 → モーダルオープン
    const commentHandler = mockApp._actionHandlers.get('cwk_acceptance_comment');
    await commentHandler({
      body: {
        actions: [{ value: JSON.stringify(metadata) }],
        trigger_id: 'trigger-123',
      },
      ack: vi.fn(),
      client: mockApp.client,
    });

    expect(mockApp.client.views.open).toHaveBeenCalledTimes(1);

    // モーダル送信
    const modalHandler = mockApp._viewHandlers.get('submit:cwk_acceptance_comment_modal');
    await modalHandler({
      ack: vi.fn(),
      view: {
        private_metadata: JSON.stringify({ id: metadata.id, storySlug: 'my-story' }),
        state: {
          values: {
            comment_block: {
              comment_input: { value: 'テスト失敗を修正してください' },
            },
          },
        },
      },
    });

    const result = await promise;
    expect(result).toEqual({ action: 'comment', text: 'テスト失敗を修正してください' });
  });

  it('スレッドセッションがある場合は thread_ts 付きで投稿する', async () => {
    await backend.startThread('my-story', 'スレッド開始');

    const promise = backend.requestAcceptanceGateAction('my-story', allPassResult);

    await vi.waitFor(() => {
      // startThread + requestAcceptanceGateAction
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledTimes(2);
    });

    const call = mockApp.client.chat.postMessage.mock.calls[1][0];
    expect(call.thread_ts).toBe('1234567890.123456');

    // cleanup
    const doneHandler = mockApp._actionHandlers.get('cwk_acceptance_done');
    const metadata = JSON.parse(call.blocks[1].elements[0].value);
    await doneHandler({
      body: { actions: [{ value: JSON.stringify(metadata) }] },
      ack: vi.fn(),
    });
    await promise;
  });
});
