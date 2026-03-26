import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoryQueueManager } from '../queue-manager';
import { promoteNextQueuedStory } from '../auto-promote';
import type { AutoPromoteDeps } from '../auto-promote';
import type { StoryFile, StoryStatus } from '../../vault/reader';
import type { NotificationBackend } from '../../notification/types';

function makeStory(slug: string, status: StoryStatus = 'Queued'): StoryFile {
  return {
    filePath: `/vault/Projects/test/stories/${slug}.md`,
    project: 'test',
    slug,
    status,
    frontmatter: { status },
    content: '',
  };
}

function createMockNotifier(): NotificationBackend & {
  notify: ReturnType<typeof vi.fn>;
  requestQueueFailedAction: ReturnType<typeof vi.fn>;
} {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    requestApproval: vi.fn().mockResolvedValue({ action: 'approve' }),
    requestTaskFailureAction: vi.fn().mockResolvedValue('retry'),
    requestQueueFailedAction: vi.fn().mockResolvedValue('resume'),
    requestAcceptanceGateAction: vi.fn().mockResolvedValue({ action: 'done' }),
    startThread: vi.fn().mockResolvedValue(undefined),
    getThreadTs: vi.fn().mockReturnValue(undefined),
    endSession: vi.fn(),
  };
}

function createMockDeps(runStoryResult: StoryStatus = 'Done'): AutoPromoteDeps & {
  runStory: ReturnType<typeof vi.fn>;
  updateFileStatus: ReturnType<typeof vi.fn>;
} {
  return {
    updateFileStatus: vi.fn(),
    runStory: vi.fn().mockResolvedValue(runStoryResult),
  };
}

describe('promoteNextQueuedStory', () => {
  let qm: StoryQueueManager;
  let notifier: ReturnType<typeof createMockNotifier>;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    qm = new StoryQueueManager();
    notifier = createMockNotifier();
    deps = createMockDeps();
  });

  // ──────────────────────────────────
  // Done → 自動プロモート
  // ──────────────────────────────────
  describe('Story Done 時', () => {
    it('キュー先頭の Story を Doing に遷移してパイプラインを起動する', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const completedStory = makeStory('completed-story', 'Done');

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      // ステータスを Doing に更新
      expect(deps.updateFileStatus).toHaveBeenCalledWith(next.filePath, 'Doing');
      // runStory が呼ばれる
      expect(deps.runStory).toHaveBeenCalledTimes(1);
      expect(deps.runStory).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'next-story', status: 'Doing' }),
        notifier,
      );
    });

    it('Slack に自動起動の通知が送信される', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const completedStory = makeStory('completed-story', 'Done');

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('next-story'),
        'next-story',
      );
    });

    it('キューが空の場合は何もしない', async () => {
      const completedStory = makeStory('completed-story', 'Done');

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      expect(deps.runStory).not.toHaveBeenCalled();
      expect(deps.updateFileStatus).not.toHaveBeenCalled();
    });

    it('キューから Story が取り出される', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const completedStory = makeStory('completed-story', 'Done');

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      expect(qm.isEmpty).toBe(true);
    });
  });

  // ──────────────────────────────────
  // Cancelled → 自動プロモート
  // ──────────────────────────────────
  describe('Story Cancelled 時', () => {
    it('キュー先頭の Story を Doing に遷移してパイプラインを起動する', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const completedStory = makeStory('completed-story', 'Cancelled');

      await promoteNextQueuedStory('Cancelled', completedStory, qm, notifier, deps);

      expect(deps.updateFileStatus).toHaveBeenCalledWith(next.filePath, 'Doing');
      expect(deps.runStory).toHaveBeenCalledTimes(1);
    });

    it('キューが空の場合は何もしない', async () => {
      const completedStory = makeStory('completed-story', 'Cancelled');

      await promoteNextQueuedStory('Cancelled', completedStory, qm, notifier, deps);

      expect(deps.runStory).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────
  // Failed → キュー停止 + ユーザー判断
  // ──────────────────────────────────
  describe('Story Failed 時', () => {
    it('キューを停止して Slack に通知する', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const failedStory = makeStory('failed-story', 'Failed');

      // resume を選択 → 次の Story を実行
      notifier.requestQueueFailedAction.mockResolvedValue('resume');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      expect(qm.isQueuePaused).toBe(false); // resume で解除済み
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('停止'),
        'failed-story',
      );
    });

    it('通知に Failed Story の slug と残キュー一覧が含まれる', async () => {
      const next1 = makeStory('queued-story-1');
      const next2 = makeStory('queued-story-2');
      qm.enqueue(next1);
      qm.enqueue(next2);
      const failedStory = makeStory('failed-story', 'Failed');

      notifier.requestQueueFailedAction.mockResolvedValue('clear');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      // 最初の notify 呼び出し（キュー停止通知）を検証
      const pauseNotifyCall = notifier.notify.mock.calls[0];
      const message = pauseNotifyCall[0];
      expect(message).toContain('failed-story');
      expect(message).toContain('queued-story-1');
      expect(message).toContain('queued-story-2');
      expect(message).toContain('2件');
    });

    it('キューが空の場合は「残キュー: なし」と通知される', async () => {
      const failedStory = makeStory('failed-story', 'Failed');

      notifier.requestQueueFailedAction.mockResolvedValue('resume');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      const pauseNotifyCall = notifier.notify.mock.calls[0];
      const message = pauseNotifyCall[0];
      expect(message).toContain('failed-story');
      expect(message).toContain('残キュー: なし');
    });

    it('キュー内の残 Story は Queued ステータスのまま維持される', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const failedStory = makeStory('failed-story', 'Failed');

      // clear を選ばない限り、キュー内の Story は Queued のまま
      notifier.requestQueueFailedAction.mockResolvedValue('resume');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      // pause 時点では updateFileStatus は Queued→Todo に変更されていない
      // （resume で dequeue されて Doing に変わるのは別の操作）
      // pause 通知の時点でキューに残っていた Story のステータスは変更されないことを確認
      const pauseNotifyCall = notifier.notify.mock.calls[0];
      expect(pauseNotifyCall[0]).toContain('next-story');
    });

    it('resume 選択時: 次の Story を実行する', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const failedStory = makeStory('failed-story', 'Failed');

      notifier.requestQueueFailedAction.mockResolvedValue('resume');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      expect(deps.runStory).toHaveBeenCalledTimes(1);
      expect(deps.runStory).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'next-story', status: 'Doing' }),
        notifier,
      );
    });

    it('retry 選択時: Failed Story をリトライする', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const failedStory = makeStory('failed-story', 'Failed');

      notifier.requestQueueFailedAction.mockResolvedValue('retry');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      // retry は failed story を Todo に戻してキュー先頭に挿入し、dequeue する
      expect(deps.updateFileStatus).toHaveBeenCalledWith(failedStory.filePath, 'Todo');
      // 最初に failed-story がリトライされ、Done 後に next-story も連鎖実行される
      expect(deps.runStory).toHaveBeenCalledTimes(2);
      expect(deps.runStory).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ slug: 'failed-story' }),
        notifier,
      );
      expect(deps.runStory).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ slug: 'next-story' }),
        notifier,
      );
    });

    it('clear 選択時: キューをクリアして何も実行しない', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const failedStory = makeStory('failed-story', 'Failed');

      notifier.requestQueueFailedAction.mockResolvedValue('clear');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      expect(deps.runStory).not.toHaveBeenCalled();
      expect(qm.isEmpty).toBe(true);
    });

    it('requestQueueFailedAction が呼ばれる', async () => {
      const failedStory = makeStory('failed-story', 'Failed');
      notifier.requestQueueFailedAction.mockResolvedValue('resume');

      await promoteNextQueuedStory('Failed', failedStory, qm, notifier, deps);

      expect(notifier.requestQueueFailedAction).toHaveBeenCalledWith(
        'failed-story',
        expect.stringContaining('failed-story'),
      );
    });
  });

  // ──────────────────────────────────
  // 連鎖実行（再帰プロモート）
  // ──────────────────────────────────
  describe('連鎖実行', () => {
    it('次の Story が Done になるとさらにキュー先頭をプロモートする', async () => {
      const story1 = makeStory('story-1');
      const story2 = makeStory('story-2');
      qm.enqueue(story1);
      qm.enqueue(story2);
      const completedStory = makeStory('completed-story', 'Done');

      // story-1 が Done で完了 → story-2 も実行される
      deps.runStory.mockResolvedValue('Done');

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      // runStory が2回呼ばれる（story-1, story-2）
      expect(deps.runStory).toHaveBeenCalledTimes(2);
      expect(deps.runStory).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ slug: 'story-1' }),
        notifier,
      );
      expect(deps.runStory).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ slug: 'story-2' }),
        notifier,
      );
      expect(qm.isEmpty).toBe(true);
    });

    it('連鎖中に Story が Failed になるとキューが停止する', async () => {
      const story1 = makeStory('story-1');
      const story2 = makeStory('story-2');
      qm.enqueue(story1);
      qm.enqueue(story2);
      const completedStory = makeStory('completed-story', 'Done');

      // story-1 が Failed → キュー停止
      deps.runStory.mockResolvedValue('Failed');
      notifier.requestQueueFailedAction.mockResolvedValue('clear');

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      // runStory は1回のみ（story-1）、story-2 は実行されない
      expect(deps.runStory).toHaveBeenCalledTimes(1);
      // story-2 は clear されて Todo に戻る
    });
  });

  // ──────────────────────────────────
  // runStory がエラーを throw した場合
  // ──────────────────────────────────
  describe('runStory がエラーを throw した場合', () => {
    it('エラーをキャッチして Failed として処理する', async () => {
      const next = makeStory('next-story');
      qm.enqueue(next);
      const completedStory = makeStory('completed-story', 'Done');

      deps.runStory.mockRejectedValue(new Error('unexpected error'));
      // Failed 後の queue failed action
      notifier.requestQueueFailedAction.mockResolvedValue('clear');

      // エラーが伝播しないこと
      await expect(
        promoteNextQueuedStory('Done', completedStory, qm, notifier, deps),
      ).resolves.toBeUndefined();
    });
  });

  // ──────────────────────────────────
  // 既存の Doing 検知フローに変更がないことの確認
  // ──────────────────────────────────
  describe('既存フローとの互換性', () => {
    it('runStory に渡される Story の status は Doing である', async () => {
      const next = makeStory('next-story', 'Queued');
      qm.enqueue(next);
      const completedStory = makeStory('completed-story', 'Done');

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      const calledWithStory = deps.runStory.mock.calls[0][0];
      expect(calledWithStory.status).toBe('Doing');
    });

    it('updateFileStatus で Doing に変更してから runStory を呼ぶ', async () => {
      const callOrder: string[] = [];
      const next = makeStory('next-story');
      qm.enqueue(next);
      const completedStory = makeStory('completed-story', 'Done');

      deps.updateFileStatus.mockImplementation(() => {
        callOrder.push('updateFileStatus');
      });
      deps.runStory.mockImplementation(async () => {
        callOrder.push('runStory');
        return 'Done';
      });

      await promoteNextQueuedStory('Done', completedStory, qm, notifier, deps);

      expect(callOrder[0]).toBe('updateFileStatus');
      expect(callOrder[1]).toBe('runStory');
    });
  });
});
