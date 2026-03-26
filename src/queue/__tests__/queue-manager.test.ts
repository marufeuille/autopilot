import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StoryQueueManager } from '../queue-manager';
import type { QueueManagerDeps } from '../queue-manager';
import type { StoryFile, StoryStatus } from '../../vault/reader';

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
      if (!story) throw new Error(`Story not found: ${slug}`);
      return story;
    }),
    updateFileStatus: vi.fn(),
  };
}

describe('StoryQueueManager', () => {
  let qm: StoryQueueManager;

  beforeEach(() => {
    qm = new StoryQueueManager();
  });

  // ──────────────────────────────────
  // isQueuePaused フラグ
  // ──────────────────────────────────
  describe('isQueuePaused フラグ', () => {
    it('初期値は false', () => {
      expect(qm.isQueuePaused).toBe(false);
    });

    it('pauseQueue() で true になる', () => {
      qm.pauseQueue();
      expect(qm.isQueuePaused).toBe(true);
    });

    it('resumeQueue() で false に戻る', () => {
      qm.pauseQueue();
      qm.resumeQueue();
      expect(qm.isQueuePaused).toBe(false);
    });
  });

  // ──────────────────────────────────
  // enqueue / dequeue 基本操作
  // ──────────────────────────────────
  describe('enqueue / dequeue', () => {
    it('FIFO 順で取り出せる', () => {
      const s1 = makeStory('story-1');
      const s2 = makeStory('story-2');
      qm.enqueue(s1);
      qm.enqueue(s2);

      expect(qm.dequeue()).toBe(s1);
      expect(qm.dequeue()).toBe(s2);
    });

    it('空のキューから dequeue すると undefined', () => {
      expect(qm.dequeue()).toBeUndefined();
    });
  });

  // ──────────────────────────────────
  // prepend
  // ──────────────────────────────────
  describe('prepend', () => {
    it('キュー先頭に挿入される', () => {
      const s1 = makeStory('story-1');
      const s2 = makeStory('story-2');
      qm.enqueue(s1);
      qm.prepend(s2);

      expect(qm.dequeue()).toBe(s2);
      expect(qm.dequeue()).toBe(s1);
    });
  });

  // ──────────────────────────────────
  // peek
  // ──────────────────────────────────
  describe('peek', () => {
    it('先頭を参照できる（取り出さない）', () => {
      const s1 = makeStory('story-1');
      qm.enqueue(s1);

      expect(qm.peek()).toBe(s1);
      expect(qm.size).toBe(1);
    });

    it('空の場合 undefined', () => {
      expect(qm.peek()).toBeUndefined();
    });
  });

  // ──────────────────────────────────
  // size / isEmpty
  // ──────────────────────────────────
  describe('size / isEmpty', () => {
    it('初期状態は size=0, isEmpty=true', () => {
      expect(qm.size).toBe(0);
      expect(qm.isEmpty).toBe(true);
    });

    it('enqueue で size が増える', () => {
      qm.enqueue(makeStory('s1'));
      qm.enqueue(makeStory('s2'));
      expect(qm.size).toBe(2);
      expect(qm.isEmpty).toBe(false);
    });
  });

  // ──────────────────────────────────
  // drain
  // ──────────────────────────────────
  describe('drain', () => {
    it('全ストーリーを取り出してキューを空にする', () => {
      const s1 = makeStory('story-1');
      const s2 = makeStory('story-2');
      qm.enqueue(s1);
      qm.enqueue(s2);

      const drained = qm.drain();
      expect(drained).toEqual([s1, s2]);
      expect(qm.isEmpty).toBe(true);
    });

    it('空のキューを drain すると空配列', () => {
      expect(qm.drain()).toEqual([]);
    });
  });

  // ──────────────────────────────────
  // ガード条件: isQueuePaused === true のとき dequeue しない
  // ──────────────────────────────────
  describe('ガード条件: pause 中は dequeue しない', () => {
    it('paused 状態で dequeue すると undefined を返す', () => {
      qm.enqueue(makeStory('story-1'));
      qm.pauseQueue();

      expect(qm.dequeue()).toBeUndefined();
      // キューには残っている
      expect(qm.size).toBe(1);
    });

    it('resumeQueue 後に dequeue できる', () => {
      const s1 = makeStory('story-1');
      qm.enqueue(s1);
      qm.pauseQueue();

      expect(qm.dequeue()).toBeUndefined();

      qm.resumeQueue();
      expect(qm.dequeue()).toBe(s1);
    });

    it('paused でも peek は参照できる', () => {
      const s1 = makeStory('story-1');
      qm.enqueue(s1);
      qm.pauseQueue();

      expect(qm.peek()).toBe(s1);
    });

    it('paused でも drain はできる（クリア操作）', () => {
      qm.enqueue(makeStory('story-1'));
      qm.pauseQueue();

      const drained = qm.drain();
      expect(drained).toHaveLength(1);
      expect(qm.isEmpty).toBe(true);
    });
  });

  // ══════════════════════════════════
  // 高レベル API: add / cancel / list / shift
  // ══════════════════════════════════

  describe('add', () => {
    it('Todo の Story をキューに追加し、ステータスを Queued に変更する', () => {
      const story = makeStory('my-story', 'Todo');
      const deps = makeDeps({ 'my-story': story });
      const qmWithDeps = new StoryQueueManager(deps);

      const result = qmWithDeps.add('my-story');

      expect(result.slug).toBe('my-story');
      expect(result.status).toBe('Queued');
      expect(qmWithDeps.size).toBe(1);
      expect(deps.updateFileStatus).toHaveBeenCalledWith(story.filePath, 'Queued');
    });

    it('FIFO 順で複数の Story を追加できる', () => {
      const s1 = makeStory('story-1', 'Todo');
      const s2 = makeStory('story-2', 'Todo');
      const deps = makeDeps({ 'story-1': s1, 'story-2': s2 });
      const qmWithDeps = new StoryQueueManager(deps);

      qmWithDeps.add('story-1');
      qmWithDeps.add('story-2');

      expect(qmWithDeps.size).toBe(2);
      const list = qmWithDeps.list();
      expect(list[0].slug).toBe('story-1');
      expect(list[1].slug).toBe('story-2');
    });

    it('同一 Story の重複追加でエラーになる', () => {
      const story = makeStory('dup-story', 'Todo');
      const deps = makeDeps({ 'dup-story': story });
      const qmWithDeps = new StoryQueueManager(deps);

      qmWithDeps.add('dup-story');

      expect(() => qmWithDeps.add('dup-story')).toThrow('既にキューに存在します');
    });

    it('Draft ステータスの Story は追加できない', () => {
      const story = makeStory('draft-story', 'Draft');
      const deps = makeDeps({ 'draft-story': story });
      const qmWithDeps = new StoryQueueManager(deps);

      expect(() => qmWithDeps.add('draft-story')).toThrow('Todo のみです');
    });

    it('Doing ステータスの Story は追加できない', () => {
      const story = makeStory('doing-story', 'Doing');
      const deps = makeDeps({ 'doing-story': story });
      const qmWithDeps = new StoryQueueManager(deps);

      expect(() => qmWithDeps.add('doing-story')).toThrow('Todo のみです');
    });

    it('Done ステータスの Story は追加できない', () => {
      const story = makeStory('done-story', 'Done');
      const deps = makeDeps({ 'done-story': story });
      const qmWithDeps = new StoryQueueManager(deps);

      expect(() => qmWithDeps.add('done-story')).toThrow('Todo のみです');
    });

    it('Failed ステータスの Story は追加できない', () => {
      const story = makeStory('failed-story', 'Failed');
      const deps = makeDeps({ 'failed-story': story });
      const qmWithDeps = new StoryQueueManager(deps);

      expect(() => qmWithDeps.add('failed-story')).toThrow('Todo のみです');
    });

    it('存在しない Story でエラーになる', () => {
      const deps = makeDeps({});
      const qmWithDeps = new StoryQueueManager(deps);

      expect(() => qmWithDeps.add('nonexistent')).toThrow('Story not found');
    });

    it('deps 未設定でエラーになる', () => {
      expect(() => qm.add('any')).toThrow('QueueManagerDeps が設定されていません');
    });
  });

  describe('cancel', () => {
    it('キュー内の Story を削除し、ステータスを Todo に戻す', () => {
      const story = makeStory('cancel-me', 'Todo');
      const deps = makeDeps({ 'cancel-me': story });
      const qmWithDeps = new StoryQueueManager(deps);

      qmWithDeps.add('cancel-me');
      expect(qmWithDeps.size).toBe(1);

      const result = qmWithDeps.cancel('cancel-me');

      expect(result.slug).toBe('cancel-me');
      expect(result.status).toBe('Todo');
      expect(qmWithDeps.size).toBe(0);
      // add で Queued, cancel で Todo の2回呼ばれる
      expect(deps.updateFileStatus).toHaveBeenLastCalledWith(story.filePath, 'Todo');
    });

    it('中間の Story を削除しても順序が維持される', () => {
      const s1 = makeStory('s1', 'Todo');
      const s2 = makeStory('s2', 'Todo');
      const s3 = makeStory('s3', 'Todo');
      const deps = makeDeps({ s1, s2, s3 });
      const qmWithDeps = new StoryQueueManager(deps);

      qmWithDeps.add('s1');
      qmWithDeps.add('s2');
      qmWithDeps.add('s3');

      qmWithDeps.cancel('s2');

      const list = qmWithDeps.list();
      expect(list).toHaveLength(2);
      expect(list[0].slug).toBe('s1');
      expect(list[1].slug).toBe('s3');
    });

    it('キューに存在しない Story でエラーになる', () => {
      const deps = makeDeps({});
      const qmWithDeps = new StoryQueueManager(deps);

      expect(() => qmWithDeps.cancel('not-in-queue')).toThrow('キューに存在しません');
    });

    it('deps 未設定でエラーになる', () => {
      expect(() => qm.cancel('any')).toThrow('QueueManagerDeps が設定されていません');
    });
  });

  describe('list', () => {
    it('キュー内のストーリー一覧を返す', () => {
      const s1 = makeStory('story-1', 'Todo');
      const s2 = makeStory('story-2', 'Todo');
      const deps = makeDeps({ 'story-1': s1, 'story-2': s2 });
      const qmWithDeps = new StoryQueueManager(deps);

      qmWithDeps.add('story-1');
      qmWithDeps.add('story-2');

      const result = qmWithDeps.list();
      expect(result).toHaveLength(2);
      expect(result[0].slug).toBe('story-1');
      expect(result[1].slug).toBe('story-2');
    });

    it('空のキューで空配列を返す', () => {
      expect(qm.list()).toEqual([]);
    });

    it('返り値を変更してもキューに影響しない（コピー）', () => {
      const s1 = makeStory('story-1', 'Todo');
      const deps = makeDeps({ 'story-1': s1 });
      const qmWithDeps = new StoryQueueManager(deps);

      qmWithDeps.add('story-1');

      const result = qmWithDeps.list();
      result.pop();

      expect(qmWithDeps.size).toBe(1);
    });
  });

  describe('shift', () => {
    it('キュー先頭の Story を取り出す', () => {
      const s1 = makeStory('story-1');
      const s2 = makeStory('story-2');
      qm.enqueue(s1);
      qm.enqueue(s2);

      expect(qm.shift()).toBe(s1);
      expect(qm.shift()).toBe(s2);
      expect(qm.size).toBe(0);
    });

    it('空のキューで undefined を返す', () => {
      expect(qm.shift()).toBeUndefined();
    });

    it('paused 状態では undefined を返す', () => {
      qm.enqueue(makeStory('story-1'));
      qm.pauseQueue();

      expect(qm.shift()).toBeUndefined();
      expect(qm.size).toBe(1);
    });

    it('resumeQueue 後に shift できる', () => {
      const s1 = makeStory('story-1');
      qm.enqueue(s1);
      qm.pauseQueue();

      expect(qm.shift()).toBeUndefined();

      qm.resumeQueue();
      expect(qm.shift()).toBe(s1);
    });
  });
});
