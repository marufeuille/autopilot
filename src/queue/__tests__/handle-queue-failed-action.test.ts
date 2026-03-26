import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoryQueueManager } from '../queue-manager';
import { handleQueueFailedAction, HandleQueueFailedActionDeps } from '../handle-queue-failed-action';
import type { StoryFile } from '../../vault/reader';
import type { NotificationBackend } from '../../notification/types';

function makeStory(slug: string, status: 'Todo' | 'Failed' = 'Failed'): StoryFile {
  return {
    filePath: `/vault/Projects/test/stories/${slug}.md`,
    project: 'test',
    slug,
    status,
    frontmatter: { status },
    content: '',
  };
}

function createMockNotifier(): NotificationBackend {
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

function createMockDeps(): HandleQueueFailedActionDeps {
  return {
    updateFileStatus: vi.fn(),
  };
}

describe('handleQueueFailedAction', () => {
  let qm: StoryQueueManager;
  let notifier: NotificationBackend;
  let deps: HandleQueueFailedActionDeps;
  let failedStory: StoryFile;

  beforeEach(() => {
    qm = new StoryQueueManager();
    notifier = createMockNotifier();
    deps = createMockDeps();
    failedStory = makeStory('failed-story');
    qm.pauseQueue(); // simulate paused state after failure
  });

  // ──────────────────────────────────
  // resume（スキップして次へ）
  // ──────────────────────────────────
  describe('resume（スキップして次へ）', () => {
    it('次の Queued Story を返して実行開始する', async () => {
      const nextStory = makeStory('next-story', 'Todo');
      qm.enqueue(nextStory);

      const result = await handleQueueFailedAction('resume', failedStory, qm, notifier, deps);

      expect(result).toEqual({ outcome: 'next', story: nextStory });
      expect(qm.isQueuePaused).toBe(false);
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('スキップしました'),
        failedStory.slug,
      );
    });

    it('キューが空の場合は「キューが空になりました」と通知する', async () => {
      const result = await handleQueueFailedAction('resume', failedStory, qm, notifier, deps);

      expect(result).toEqual({ outcome: 'empty' });
      expect(qm.isQueuePaused).toBe(false);
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('キューが空になりました'),
        failedStory.slug,
      );
    });

    it('キューに複数 Story がある場合、先頭の Story のみ取り出す', async () => {
      const s1 = makeStory('story-1', 'Todo');
      const s2 = makeStory('story-2', 'Todo');
      qm.enqueue(s1);
      qm.enqueue(s2);

      const result = await handleQueueFailedAction('resume', failedStory, qm, notifier, deps);

      expect(result).toEqual({ outcome: 'next', story: s1 });
      expect(qm.size).toBe(1);
    });
  });

  // ──────────────────────────────────
  // retry（このStoryをリトライ）
  // ──────────────────────────────────
  describe('retry（このStoryをリトライ）', () => {
    it('Failed Story を Todo に戻し、キュー先頭に再追加して返す', async () => {
      const nextStory = makeStory('next-story', 'Todo');
      qm.enqueue(nextStory);

      const result = await handleQueueFailedAction('retry', failedStory, qm, notifier, deps);

      expect(result.outcome).toBe('next');
      if (result.outcome === 'next') {
        expect(result.story.slug).toBe('failed-story');
        expect(result.story.status).toBe('Todo');
      }
      expect(deps.updateFileStatus).toHaveBeenCalledWith(failedStory.filePath, 'Todo');
      expect(qm.isQueuePaused).toBe(false);
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('リトライします'),
        failedStory.slug,
      );
    });

    it('キューが空でもリトライ Story 自身がキュー先頭になる', async () => {
      const result = await handleQueueFailedAction('retry', failedStory, qm, notifier, deps);

      expect(result.outcome).toBe('next');
      if (result.outcome === 'next') {
        expect(result.story.slug).toBe('failed-story');
      }
      expect(deps.updateFileStatus).toHaveBeenCalledWith(failedStory.filePath, 'Todo');
    });

    it('リトライ後、残りのキューは維持される', async () => {
      const s1 = makeStory('story-1', 'Todo');
      const s2 = makeStory('story-2', 'Todo');
      qm.enqueue(s1);
      qm.enqueue(s2);

      const result = await handleQueueFailedAction('retry', failedStory, qm, notifier, deps);

      expect(result.outcome).toBe('next');
      // failed-story がキュー先頭として取り出されたので、残りは s1, s2
      expect(qm.size).toBe(2);
    });
  });

  // ──────────────────────────────────
  // clear（キューをすべてクリア）
  // ──────────────────────────────────
  describe('clear（キューをすべてクリア）', () => {
    it('残りの Queued Stories を Todo に戻しキューを空にする', async () => {
      const s1 = makeStory('story-1', 'Todo');
      const s2 = makeStory('story-2', 'Todo');
      qm.enqueue(s1);
      qm.enqueue(s2);

      const result = await handleQueueFailedAction('clear', failedStory, qm, notifier, deps);

      expect(result).toEqual({ outcome: 'cleared' });
      expect(qm.isEmpty).toBe(true);
      expect(deps.updateFileStatus).toHaveBeenCalledWith(s1.filePath, 'Todo');
      expect(deps.updateFileStatus).toHaveBeenCalledWith(s2.filePath, 'Todo');
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('キューをクリアしました'),
        failedStory.slug,
      );
    });

    it('キューが空でもクリア操作は成功する', async () => {
      const result = await handleQueueFailedAction('clear', failedStory, qm, notifier, deps);

      expect(result).toEqual({ outcome: 'cleared' });
      expect(qm.isEmpty).toBe(true);
      expect(deps.updateFileStatus).not.toHaveBeenCalled();
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('0件'),
        failedStory.slug,
      );
    });

    it('クリアされた Story の数が通知メッセージに含まれる', async () => {
      qm.enqueue(makeStory('s1', 'Todo'));
      qm.enqueue(makeStory('s2', 'Todo'));
      qm.enqueue(makeStory('s3', 'Todo'));

      await handleQueueFailedAction('clear', failedStory, qm, notifier, deps);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.stringContaining('3件'),
        failedStory.slug,
      );
    });
  });

  // ──────────────────────────────────
  // Slack結果メッセージの投稿確認
  // ──────────────────────────────────
  describe('各アクション実行後のSlack通知', () => {
    it('resume: 結果メッセージがSlackに投稿される', async () => {
      qm.enqueue(makeStory('next', 'Todo'));
      await handleQueueFailedAction('resume', failedStory, qm, notifier, deps);
      expect(notifier.notify).toHaveBeenCalledTimes(1);
    });

    it('retry: 結果メッセージがSlackに投稿される', async () => {
      await handleQueueFailedAction('retry', failedStory, qm, notifier, deps);
      expect(notifier.notify).toHaveBeenCalledTimes(1);
    });

    it('clear: 結果メッセージがSlackに投稿される', async () => {
      await handleQueueFailedAction('clear', failedStory, qm, notifier, deps);
      expect(notifier.notify).toHaveBeenCalledTimes(1);
    });
  });
});
