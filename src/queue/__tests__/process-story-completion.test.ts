import { describe, it, expect, beforeEach } from 'vitest';
import { StoryQueueManager } from '../queue-manager';
import { processStoryCompletion } from '../process-story-completion';
import type { StoryFile } from '../../vault/reader';

function makeStory(slug: string): StoryFile {
  return {
    filePath: `/vault/Projects/test/stories/${slug}.md`,
    project: 'test',
    slug,
    status: 'Todo',
    frontmatter: { status: 'Todo' },
    content: '',
  };
}

describe('processStoryCompletion', () => {
  let qm: StoryQueueManager;

  beforeEach(() => {
    qm = new StoryQueueManager();
  });

  // ──────────────────────────────────
  // Failed → キュー停止
  // ──────────────────────────────────
  describe('Failed ステータス', () => {
    it('キューを停止する（isQueuePaused = true）', () => {
      qm.enqueue(makeStory('next-story'));

      const result = processStoryCompletion('Failed', qm);

      expect(result).toEqual({ action: 'paused' });
      expect(qm.isQueuePaused).toBe(true);
    });

    it('キューが空でも停止する', () => {
      const result = processStoryCompletion('Failed', qm);

      expect(result).toEqual({ action: 'paused' });
      expect(qm.isQueuePaused).toBe(true);
    });

    it('停止中は dequeue できない', () => {
      qm.enqueue(makeStory('next-story'));

      processStoryCompletion('Failed', qm);

      expect(qm.dequeue()).toBeUndefined();
      expect(qm.size).toBe(1);
    });
  });

  // ──────────────────────────────────
  // Done → キュー継続
  // ──────────────────────────────────
  describe('Done ステータス', () => {
    it('キューに Story がある場合は continue を返す', () => {
      qm.enqueue(makeStory('next-story'));

      const result = processStoryCompletion('Done', qm);

      expect(result).toEqual({ action: 'continue' });
      expect(qm.isQueuePaused).toBe(false);
    });

    it('キューが空の場合は noop を返す', () => {
      const result = processStoryCompletion('Done', qm);

      expect(result).toEqual({ action: 'noop' });
      expect(qm.isQueuePaused).toBe(false);
    });
  });

  // ──────────────────────────────────
  // Cancelled → キュー継続
  // ──────────────────────────────────
  describe('Cancelled ステータス', () => {
    it('キューに Story がある場合は continue を返す', () => {
      qm.enqueue(makeStory('next-story'));

      const result = processStoryCompletion('Cancelled', qm);

      expect(result).toEqual({ action: 'continue' });
      expect(qm.isQueuePaused).toBe(false);
    });

    it('キューが空の場合は noop を返す', () => {
      const result = processStoryCompletion('Cancelled', qm);

      expect(result).toEqual({ action: 'noop' });
      expect(qm.isQueuePaused).toBe(false);
    });

    it('Cancelled 後も dequeue できる', () => {
      const next = makeStory('next-story');
      qm.enqueue(next);

      processStoryCompletion('Cancelled', qm);

      expect(qm.dequeue()).toBe(next);
    });
  });

  // ──────────────────────────────────
  // Todo / Doing（非終端ステータス）→ キュー継続
  // ──────────────────────────────────
  describe('非終端ステータス（Todo / Doing）', () => {
    it('Todo でもキューは停止しない', () => {
      qm.enqueue(makeStory('next-story'));

      const result = processStoryCompletion('Todo', qm);

      expect(result).toEqual({ action: 'continue' });
      expect(qm.isQueuePaused).toBe(false);
    });

    it('Doing でもキューは停止しない', () => {
      qm.enqueue(makeStory('next-story'));

      const result = processStoryCompletion('Doing', qm);

      expect(result).toEqual({ action: 'continue' });
      expect(qm.isQueuePaused).toBe(false);
    });
  });

  // ──────────────────────────────────
  // resumeQueue 後の動作確認
  // ──────────────────────────────────
  describe('Failed 後の resumeQueue', () => {
    it('resumeQueue 後に dequeue できるようになる', () => {
      const next = makeStory('next-story');
      qm.enqueue(next);

      processStoryCompletion('Failed', qm);
      expect(qm.dequeue()).toBeUndefined();

      qm.resumeQueue();
      expect(qm.dequeue()).toBe(next);
    });
  });
});
