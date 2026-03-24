import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerPRRejectHandlers } from '../slack';

// signalRejection をモック
vi.mock('../../merge/rejection-registry', () => ({
  signalRejection: vi.fn().mockReturnValue(true),
}));

import { signalRejection } from '../../merge/rejection-registry';

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

describe('registerPRRejectHandlers', () => {
  let mockApp: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    mockApp = createMockApp();
    registerPRRejectHandlers(mockApp);
  });

  it('pr_reject_ng アクションハンドラーが登録される', () => {
    expect(mockApp.action).toHaveBeenCalledWith('pr_reject_ng', expect.any(Function));
  });

  it('pr_reject_modal ビューハンドラーが登録される', () => {
    expect(mockApp.view).toHaveBeenCalledWith('pr_reject_modal', expect.any(Function));
  });

  describe('pr_reject_ng アクション（NG ボタンクリック）', () => {
    it('ack が呼ばれる', async () => {
      const handler = mockApp._actionHandlers.get('pr_reject_ng');
      const ack = vi.fn();
      await handler({
        ack,
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
          trigger_id: 'trigger-123',
        },
        client: {
          views: { open: vi.fn().mockResolvedValue({}) },
        },
      });
      expect(ack).toHaveBeenCalled();
    });

    it('理由入力モーダルが開かれる', async () => {
      const handler = mockApp._actionHandlers.get('pr_reject_ng');
      const mockViewsOpen = vi.fn().mockResolvedValue({});
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
          trigger_id: 'trigger-123',
        },
        client: {
          views: { open: mockViewsOpen },
        },
      });

      expect(mockViewsOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger_id: 'trigger-123',
          view: expect.objectContaining({
            type: 'modal',
            callback_id: 'pr_reject_modal',
            private_metadata: 'https://github.com/org/repo/pull/42',
          }),
        }),
      );
    });

    it('モーダルに reason_block / reason_input が含まれる', async () => {
      const handler = mockApp._actionHandlers.get('pr_reject_ng');
      const mockViewsOpen = vi.fn().mockResolvedValue({});
      await handler({
        ack: vi.fn(),
        body: {
          actions: [{ value: 'https://github.com/org/repo/pull/42' }],
          trigger_id: 'trigger-456',
        },
        client: {
          views: { open: mockViewsOpen },
        },
      });

      const viewArg = mockViewsOpen.mock.calls[0][0].view;
      const inputBlock = viewArg.blocks.find((b: any) => b.block_id === 'reason_block');
      expect(inputBlock).toBeDefined();
      expect(inputBlock.element.action_id).toBe('reason_input');
      expect(inputBlock.element.type).toBe('plain_text_input');
    });
  });

  describe('pr_reject_modal ビュー送信', () => {
    it('ack が呼ばれる', async () => {
      const handler = mockApp._viewHandlers.get('submit:pr_reject_modal');
      const ack = vi.fn();
      await handler({
        ack,
        view: {
          private_metadata: 'https://github.com/org/repo/pull/42',
          state: {
            values: {
              reason_block: {
                reason_input: { value: 'テストが不十分です' },
              },
            },
          },
        },
      });
      expect(ack).toHaveBeenCalled();
    });

    it('signalRejection が prUrl と reason で呼び出される', async () => {
      const handler = mockApp._viewHandlers.get('submit:pr_reject_modal');
      await handler({
        ack: vi.fn(),
        view: {
          private_metadata: 'https://github.com/org/repo/pull/42',
          state: {
            values: {
              reason_block: {
                reason_input: { value: 'テストが不十分です' },
              },
            },
          },
        },
      });

      expect(signalRejection).toHaveBeenCalledWith(
        'https://github.com/org/repo/pull/42',
        'テストが不十分です',
      );
    });

    it('reason が null の場合は空文字で signalRejection が呼ばれる', async () => {
      const handler = mockApp._viewHandlers.get('submit:pr_reject_modal');
      await handler({
        ack: vi.fn(),
        view: {
          private_metadata: 'https://github.com/org/repo/pull/99',
          state: {
            values: {
              reason_block: {
                reason_input: { value: null },
              },
            },
          },
        },
      });

      expect(signalRejection).toHaveBeenCalledWith(
        'https://github.com/org/repo/pull/99',
        '',
      );
    });
  });
});
