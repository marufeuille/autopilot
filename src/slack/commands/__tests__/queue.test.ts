import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createQueueHandler } from '../queue';
import { StoryQueueManager } from '../../../queue/queue-manager';
import type { QueueManagerDeps } from '../../../queue/queue-manager';
import type { StoryFile, StoryStatus } from '../../../vault/reader';

function makeStory(slug: string, status: StoryStatus = 'Todo'): StoryFile {
  return {
    filePath: `/vault/Projects/test/stories/${slug}.md`,
    project: 'test',
    slug,
    status,
    frontmatter: { status },
    content: '',
  };
}

function makeDeps(stories: Record<string, StoryFile> = {}): QueueManagerDeps {
  return {
    readStoryBySlug: vi.fn((slug: string) => {
      const story = stories[slug];
      if (!story) throw new Error(`Story "${slug}" が見つかりません`);
      return story;
    }),
    updateFileStatus: vi.fn(),
  };
}

describe('createQueueHandler', () => {
  let qm: StoryQueueManager;
  let respond: ReturnType<typeof vi.fn>;
  let deps: QueueManagerDeps;

  beforeEach(() => {
    deps = makeDeps({
      'my-story': makeStory('my-story', 'Todo'),
      'story-2': makeStory('story-2', 'Todo'),
      'draft-story': makeStory('draft-story', 'Draft'),
      'doing-story': makeStory('doing-story', 'Doing'),
    });
    qm = new StoryQueueManager(deps);
    respond = vi.fn().mockResolvedValue(undefined);
  });

  // ──────────────────────────────────
  // 引数なし → ヘルプ
  // ──────────────────────────────────
  describe('引数なし', () => {
    it('ヘルプメッセージを表示する', async () => {
      const handler = createQueueHandler(qm);
      await handler([], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('/ap queue add'),
      );
      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('/ap queue cancel'),
      );
      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('/ap queue list'),
      );
    });
  });

  // ──────────────────────────────────
  // 不明なサブアクション
  // ──────────────────────────────────
  describe('不明なサブアクション', () => {
    it('エラーメッセージとヘルプを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['unknown'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('不明なキューコマンド'),
      );
    });
  });

  // ──────────────────────────────────
  // /ap queue add
  // ──────────────────────────────────
  describe('/ap queue add', () => {
    it('Todo ステータスの Story をキューに追加できる', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('my-story'),
      );
      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('キューに追加しました'),
      );
      expect(qm.list()).toHaveLength(1);
      expect(qm.list()[0].slug).toBe('my-story');
    });

    it('追加後のキュー位置が表示される', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('位置: 1'),
      );
    });

    it('複数 Story を追加するとキュー末尾に追加される', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);
      await handler(['add', 'story-2'], respond);

      expect(qm.list()).toHaveLength(2);
      expect(qm.list()[0].slug).toBe('my-story');
      expect(qm.list()[1].slug).toBe('story-2');

      // 2つ目のレスポンスは位置2
      expect(respond).toHaveBeenLastCalledWith(
        expect.stringContaining('位置: 2'),
      );
    });

    it('slug が未指定の場合はエラーメッセージを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('ストーリースラッグを指定してください'),
      );
      expect(qm.list()).toHaveLength(0);
    });

    it('存在しない slug を指定するとエラーメッセージを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'nonexistent'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('エラーが発生しました'),
      );
      expect(qm.list()).toHaveLength(0);
    });

    it('パストラバーサルを含む slug を指定するとエラーメッセージを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', '../../etc/passwd'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('不正なストーリースラッグです'),
      );
      expect(qm.list()).toHaveLength(0);
    });

    it('ドットを含む slug を指定するとエラーメッセージを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', '../secret'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('不正なストーリースラッグです'),
      );
      expect(qm.list()).toHaveLength(0);
    });

    it('Draft ステータスの Story はエラーになる', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'draft-story'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('エラーが発生しました'),
      );
      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('Draft'),
      );
      expect(qm.list()).toHaveLength(0);
    });

    it('Doing ステータスの Story はエラーになる', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'doing-story'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('エラーが発生しました'),
      );
      expect(qm.list()).toHaveLength(0);
    });

    it('重複追加はエラーになる', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);
      await handler(['add', 'my-story'], respond);

      expect(respond).toHaveBeenLastCalledWith(
        expect.stringContaining('エラーが発生しました'),
      );
      expect(qm.list()).toHaveLength(1);
    });
  });

  // ──────────────────────────────────
  // /ap queue cancel
  // ──────────────────────────────────
  describe('/ap queue cancel', () => {
    it('キュー内の Story を削除し Todo に戻す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);
      await handler(['cancel', 'my-story'], respond);

      expect(respond).toHaveBeenLastCalledWith(
        expect.stringContaining('キューから削除'),
      );
      expect(respond).toHaveBeenLastCalledWith(
        expect.stringContaining('Todo'),
      );
      expect(qm.list()).toHaveLength(0);
    });

    it('slug が未指定の場合はエラーメッセージを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['cancel'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('ストーリースラッグを指定してください'),
      );
    });

    it('パストラバーサルを含む slug で cancel するとエラーメッセージを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['cancel', '../../etc/passwd'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('不正なストーリースラッグです'),
      );
    });

    it('キューにない Story を cancel するとエラーになる', async () => {
      const handler = createQueueHandler(qm);
      await handler(['cancel', 'nonexistent'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('エラーが発生しました'),
      );
    });
  });

  // ──────────────────────────────────
  // /ap queue list
  // ──────────────────────────────────
  describe('/ap queue list', () => {
    it('キューが空の場合は空メッセージを返す', async () => {
      const handler = createQueueHandler(qm);
      await handler(['list'], respond);

      expect(respond).toHaveBeenCalledWith(
        expect.stringContaining('キューは空です'),
      );
    });

    it('キュー内の Story を順序付きで表示する', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);
      await handler(['add', 'story-2'], respond);
      await handler(['list'], respond);

      const lastCall = respond.mock.calls[respond.mock.calls.length - 1][0];
      expect(lastCall).toContain('ストーリーキュー');
      expect(lastCall).toContain('2件');
      expect(lastCall).toContain('1. `my-story`');
      expect(lastCall).toContain('2. `story-2`');
    });

    it('キューが一時停止中の場合はその旨を表示する', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);
      qm.pauseQueue();
      await handler(['list'], respond);

      const lastCall = respond.mock.calls[respond.mock.calls.length - 1][0];
      expect(lastCall).toContain('一時停止中');
    });

    it('キューが動作中の場合は一時停止メッセージを表示しない', async () => {
      const handler = createQueueHandler(qm);
      await handler(['add', 'my-story'], respond);
      await handler(['list'], respond);

      const lastCall = respond.mock.calls[respond.mock.calls.length - 1][0];
      expect(lastCall).not.toContain('一時停止中');
    });
  });
});
