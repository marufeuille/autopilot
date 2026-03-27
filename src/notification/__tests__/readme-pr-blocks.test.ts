import { describe, it, expect } from 'vitest';
import { buildReadmePRBlocks } from '../message-builder';

describe('buildReadmePRBlocks', () => {
  const prUrl = 'https://github.com/org/repo/pull/42';
  const storySlug = 'my-story';

  it('section ブロックにストーリー slug と PR URL が含まれる', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section).toBeDefined();
    expect(section.text.type).toBe('mrkdwn');
    expect(section.text.text).toContain(storySlug);
    expect(section.text.text).toContain(prUrl);
    expect(section.text.text).toContain('README 更新 PR 作成');
  });

  it('actions ブロックに却下ボタンが含まれる', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const actions = blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(1);
  });

  it('却下ボタンの action_id が readme_pr_reject である', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const actions = blocks.find((b: any) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.action_id).toBe('readme_pr_reject');
  });

  it('却下ボタンの value に prUrl が埋め込まれている', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const actions = blocks.find((b: any) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.value).toBe(prUrl);
  });

  it('却下ボタンが danger スタイル（赤）である', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const actions = blocks.find((b: any) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.style).toBe('danger');
  });

  it('却下ボタンのテキストが「❌ 却下」である', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const actions = blocks.find((b: any) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.text.type).toBe('plain_text');
    expect(button.text.text).toBe('❌ 却下');
  });

  it('PR URL が <url|label> 形式でリンク化される', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section.text.text).toContain(`<${prUrl}|${prUrl}>`);
  });

  it('レビュー・マージ依頼のメッセージが含まれる', () => {
    const blocks = buildReadmePRBlocks(prUrl, storySlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section.text.text).toContain('レビュー・マージをお願いします');
  });

  it('悪意ある mrkdwn 構文を含む URL がサニタイズされる', () => {
    const maliciousUrl = 'https://evil.com|innocent<script>';
    const blocks = buildReadmePRBlocks(maliciousUrl, storySlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section.text.text).not.toContain('|innocent');
    expect(section.text.text).not.toContain('<script>');
  });

  it('却下ボタンの value にもサニタイズ済み URL が使われる', () => {
    const maliciousUrl = 'https://evil.com|innocent<script>';
    const blocks = buildReadmePRBlocks(maliciousUrl, storySlug) as any[];
    const actions = blocks.find((b: any) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.value).toBe('https://evil.cominnocentscript');
    expect(button.value).not.toContain('<');
    expect(button.value).not.toContain('>');
    expect(button.value).not.toContain('|');
  });
});
