import { describe, it, expect } from 'vitest';
import { buildMergeReadyBlocks, buildRejectModal } from '../message-builder';

describe('buildMergeReadyBlocks', () => {
  const prUrl = 'https://github.com/org/repo/pull/42';
  const taskSlug = 'my-task-01';

  it('section ブロックにタスク slug と PR URL が含まれる', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section).toBeDefined();
    expect(section.text.type).toBe('mrkdwn');
    expect(section.text.text).toContain(taskSlug);
    expect(section.text.text).toContain(prUrl);
    expect(section.text.text).toContain('マージ準備完了');
  });

  it('actions ブロックに NG ボタンが含まれる', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(1);
  });

  it('NG ボタンの action_id が pr_reject_ng である', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const actions = blocks.find((b) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.action_id).toBe('pr_reject_ng');
  });

  it('NG ボタンの value に prUrl が埋め込まれている', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const actions = blocks.find((b) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.value).toBe(prUrl);
  });

  it('NG ボタンが danger スタイル（赤）である', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const actions = blocks.find((b) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.style).toBe('danger');
  });

  it('NG ボタンのテキストが「❌ NG（却下）」である', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const actions = blocks.find((b) => b.type === 'actions');
    const button = actions.elements[0];
    expect(button.text.type).toBe('plain_text');
    expect(button.text.text).toBe('❌ NG（却下）');
  });

  it('既存の通知内容（CI通過メッセージ）が維持されている', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section.text.text).toContain('CIが通過しました');
    expect(section.text.text).toContain('手動でマージ');
  });

  it('PR URL が <url|label> 形式でリンク化される', () => {
    const blocks = buildMergeReadyBlocks(prUrl, taskSlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    expect(section.text.text).toContain(`<${prUrl}|${prUrl}>`);
  });

  it('悪意ある mrkdwn 構文を含む URL がサニタイズされる', () => {
    const maliciousUrl = 'https://evil.com|innocent<script>';
    const blocks = buildMergeReadyBlocks(maliciousUrl, taskSlug) as any[];
    const section = blocks.find((b: any) => b.type === 'section');
    // < > | が除去されている
    expect(section.text.text).not.toContain('|innocent');
    expect(section.text.text).not.toContain('<script>');
  });
});

describe('buildRejectModal', () => {
  const prUrl = 'https://github.com/org/repo/pull/42';

  it('type が modal である', () => {
    const modal = buildRejectModal(prUrl);
    expect(modal.type).toBe('modal');
  });

  it('callback_id が pr_reject_modal である', () => {
    const modal = buildRejectModal(prUrl);
    expect(modal.callback_id).toBe('pr_reject_modal');
  });

  it('private_metadata に prUrl が埋め込まれている', () => {
    const modal = buildRejectModal(prUrl);
    expect(modal.private_metadata).toBe(prUrl);
  });

  it('submit ボタンと close ボタンが設定されている', () => {
    const modal = buildRejectModal(prUrl);
    expect(modal.submit).toEqual({ type: 'plain_text', text: '送信' });
    expect(modal.close).toEqual({ type: 'plain_text', text: 'キャンセル' });
  });

  it('plain_text_input 要素が block_id: reason_block, action_id: reason_input で配置されている', () => {
    const modal = buildRejectModal(prUrl);
    const blocks = modal.blocks as any[];
    expect(blocks).toHaveLength(1);

    const inputBlock = blocks[0];
    expect(inputBlock.type).toBe('input');
    expect(inputBlock.block_id).toBe('reason_block');
    expect(inputBlock.element.type).toBe('plain_text_input');
    expect(inputBlock.element.action_id).toBe('reason_input');
    expect(inputBlock.element.multiline).toBe(true);
  });
});
