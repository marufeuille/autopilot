import { describe, it, expect, beforeEach } from 'vitest';
import { StoryQueueManager } from '../queue-manager';
import type { StoryFile } from '../../vault/reader';

function makeStory(slug: string, status: 'Todo' | 'Doing' = 'Todo'): StoryFile {
  return {
    filePath: `/vault/Projects/test/stories/${slug}.md`,
    project: 'test',
    slug,
    status,
    frontmatter: { status },
    content: '',
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
});
