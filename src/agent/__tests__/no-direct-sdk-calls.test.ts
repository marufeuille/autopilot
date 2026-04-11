/**
 * コードベース内で AgentBackend を経由せずに @anthropic-ai/claude-agent-sdk を
 * 直接呼び出しているファイルが存在しないことを検証するテスト。
 *
 * backend.ts のみが SDK を直接インポートすることを保証し、
 * 後続のバックエンド追加時に一元管理が崩れていないことを自動検出する。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

const SRC_DIR = path.resolve(__dirname, '../..');

/** SDK の直接インポートが許可されるファイル（テストファイルを除く本番コード） */
const ALLOWED_FILES = new Set([
  path.resolve(SRC_DIR, 'agent/backend.ts'),
]);

describe('AgentBackend SDK 一元管理の検証', () => {
  it('本番コードで @anthropic-ai/claude-agent-sdk を直接インポートしているのは backend.ts のみ', () => {
    // src/ 配下の .ts ファイルを取得（テストファイルを除外）
    const allTsFiles = glob.sync('**/*.ts', {
      cwd: SRC_DIR,
      absolute: true,
      ignore: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts'],
    });

    const violations: string[] = [];

    for (const filePath of allTsFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');

      // 静的インポート: import ... from '@anthropic-ai/claude-agent-sdk'
      const hasStaticImport = /from\s+['"]@anthropic-ai\/claude-agent-sdk['"]/.test(content);
      // 動的インポート: import('@anthropic-ai/claude-agent-sdk')
      const hasDynamicImport = /import\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]\s*\)/.test(content);

      if ((hasStaticImport || hasDynamicImport) && !ALLOWED_FILES.has(filePath)) {
        const relativePath = path.relative(SRC_DIR, filePath);
        violations.push(relativePath);
      }
    }

    expect(violations).toEqual([]);
  });

  it('AgentBackend interface が run メソッドを持つ', async () => {
    const { ClaudeBackend } = await import('../backend');
    const backend = new ClaudeBackend();
    expect(typeof backend.run).toBe('function');
  });

  it('AgentBackend interface に JSDoc コメントが記載されている', () => {
    const backendFilePath = path.resolve(SRC_DIR, 'agent/backend.ts');
    const content = fs.readFileSync(backendFilePath, 'utf-8');

    // interface に JSDoc が付いていることを確認
    expect(content).toContain('* エージェントバックエンドの抽象インターフェース。');
    expect(content).toContain('* @example 新しいバックエンドの追加手順');
    // run メソッドに JSDoc が付いていることを確認
    expect(content).toContain('* @param prompt');
    expect(content).toContain('* @param options');
    expect(content).toContain('* @returns');
  });

  it('createBackend ファクトリに拡張ポイントの JSDoc が記載されている', () => {
    const backendFilePath = path.resolve(SRC_DIR, 'agent/backend.ts');
    const content = fs.readFileSync(backendFilePath, 'utf-8');

    expect(content).toContain('* 新しいバックエンドを追加する際は、ここに `case` 分岐を追加する');
    expect(content).toContain('exhaustive check');
  });

  it('ClaudeBackend が唯一の SDK 呼び出し箇所であることを示す JSDoc がある', () => {
    const backendFilePath = path.resolve(SRC_DIR, 'agent/backend.ts');
    const content = fs.readFileSync(backendFilePath, 'utf-8');

    expect(content).toContain('このクラスがコードベース内で `query()` SDK を直接呼び出す唯一の場所となる');
  });
});
