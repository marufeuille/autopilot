import { query } from '@anthropic-ai/claude-agent-sdk';
import { createCommandLogger } from '../logger';

const log = createCommandLogger('agent-backend');

/**
 * エージェント実行時のオプション。
 */
export interface AgentRunOptions {
  /** 作業ディレクトリ */
  cwd: string;
  /** 許可するツール一覧（省略時は Claude Code 既定のツールセット） */
  allowedTools?: string[];
  /** 権限モード（省略時は 'bypassPermissions'） */
  permissionMode?: 'default' | 'bypassPermissions';
}

/**
 * エージェントバックエンドの抽象インターフェース。
 * step ごとに異なるバックエンドを差し替え可能にするための共通契約。
 */
export interface AgentBackend {
  run(prompt: string, options: AgentRunOptions): Promise<string>;
}

/**
 * Claude Code（query SDK）をラップする AgentBackend 実装。
 *
 * `@anthropic-ai/claude-agent-sdk` の `query()` は Claude Code のプログラマティック
 * インターフェースであり、CLI の `claude` コマンドと同等の機能を提供する。
 * 既存の runner-deps.ts / review/loop.ts と同じ呼び出しパターンに準拠している。
 */
export class ClaudeBackend implements AgentBackend {
  async run(prompt: string, options: AgentRunOptions): Promise<string> {
    const chunks: string[] = [];

    try {
      for await (const message of query({
        prompt,
        options: {
          cwd: options.cwd,
          allowedTools: options.allowedTools ?? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
          permissionMode: options.permissionMode ?? 'bypassPermissions',
        },
      })) {
        if (message.type === 'assistant') {
          const content = message.message?.content ?? [];
          for (const block of content) {
            if ('text' in block && block.text) {
              chunks.push(block.text);
            }
          }
        } else if (message.type === 'result') {
          log.info('agent result', { subtype: message.subtype, phase: 'agent_execution' });
          if (message.subtype === 'success' && 'result' in message) {
            const resultText = (message as { result?: string }).result;
            if (resultText) {
              chunks.push(resultText);
            }
          }
        }
      }
    } catch (error) {
      log.error('Claude Code execution failed', { error, phase: 'agent_execution' });
      throw error;
    }

    return chunks.join('\n');
  }
}
