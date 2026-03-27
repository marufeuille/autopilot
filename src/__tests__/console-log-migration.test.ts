import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * console.log / console.warn / console.error の直接使用が
 * runner.ts / runner-deps.ts から除去されていることを検証するテスト。
 *
 * logger.ts 自体は console.log/warn/error を内部で使用するため除外。
 */
describe('console.log migration', () => {
  const srcDir = join(__dirname, '..');

  const targetFiles = [
    'runner.ts',
    'runner-deps.ts',
  ];

  for (const file of targetFiles) {
    describe(file, () => {
      const content = readFileSync(join(srcDir, file), 'utf-8');

      it('console.log の直接呼び出しが残っていない', () => {
        // process.stdout.write は対象外
        const matches = content.match(/\bconsole\.log\b/g);
        expect(matches).toBeNull();
      });

      it('console.warn の直接呼び出しが残っていない', () => {
        const matches = content.match(/\bconsole\.warn\b/g);
        expect(matches).toBeNull();
      });

      it('console.error の直接呼び出しが残っていない', () => {
        const matches = content.match(/\bconsole\.error\b/g);
        expect(matches).toBeNull();
      });

      it('createCommandLogger をインポートしている', () => {
        expect(content).toContain("import { createCommandLogger } from './logger'");
      });
    });
  }

  describe('runner.ts のログフォーマット', () => {
    const content = readFileSync(join(srcDir, 'runner.ts'), 'utf-8');

    it('[runner] プレフィックスがメッセージ内に残っていない', () => {
      // logger の module フィールドで自動付与されるため、メッセージ内の [runner] は不要
      // import 文や変数名ではなく、文字列リテラル内の [runner] を検出
      const stringLiterals = content.match(/'[^']*\[runner\][^']*'|`[^`]*\[runner\][^`]*`/g);
      expect(stringLiterals).toBeNull();
    });
  });

  describe('runner-deps.ts のログフォーマット', () => {
    const content = readFileSync(join(srcDir, 'runner-deps.ts'), 'utf-8');

    it('[runner-deps] プレフィックスがメッセージ内に残っていない', () => {
      const stringLiterals = content.match(/'[^']*\[runner-deps\][^']*'|`[^`]*\[runner-deps\][^`]*`/g);
      expect(stringLiterals).toBeNull();
    });

    it('[runner] プレフィックスがメッセージ内に残っていない', () => {
      const stringLiterals = content.match(/'[^']*\[runner\][^']*'|`[^`]*\[runner\][^`]*`/g);
      expect(stringLiterals).toBeNull();
    });
  });
});
