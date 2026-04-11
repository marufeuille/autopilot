import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options as QueryOptions } from '@anthropic-ai/claude-agent-sdk';
import { createCommandLogger } from '../logger';
import type { AgentBackendConfig } from '../config';

const log = createCommandLogger('agent-backend');

/**
 * エージェント実行時のオプション。
 *
 * すべてのバックエンド実装が共通で受け取るパラメータを定義する。
 * 新しいバックエンド（例: Codex）を追加する際も、このオプションを
 * 各バックエンド固有のパラメータにマッピングすることで差し替えを実現する。
 */
export interface AgentRunOptions {
  /** 作業ディレクトリ（ツールを使わないテキスト生成のみの場合は省略可能） */
  cwd?: string;
  /** 許可するツール一覧（省略時は Claude Code 既定のツールセット） */
  allowedTools?: string[];
  /** 権限モード（省略時は 'bypassPermissions'） */
  permissionMode?: 'default' | 'bypassPermissions' | 'plan';
  /** 中断シグナル（タイムアウトやキャンセル制御用） */
  abortSignal?: AbortSignal;
}

/**
 * エージェントバックエンドの抽象インターフェース。
 *
 * step ごとに異なるバックエンドを差し替え可能にするための共通契約。
 * 現時点では Claude Code（{@link ClaudeBackend}）のみ実装されているが、
 * 後続ストーリーで Codex 等の別バックエンドを追加する際は、
 * このインターフェースを実装することで、既存コードを変更せずに差し替えできる。
 *
 * @example 新しいバックエンドの追加手順:
 * 1. `AgentBackend` を実装するクラスを作成する（例: `CodexBackend`）
 * 2. `AgentBackendType` に新しい type を追加する（例: `'codex'`）
 * 3. `createBackend()` ファクトリに分岐を追加する
 * 4. config の `agentBackends` で step ごとにバックエンドを指定する
 */
export interface AgentBackend {
  /**
   * プロンプトを送信してエージェントを実行し、テキスト応答を返す。
   *
   * @param prompt - エージェントに送信するプロンプト文字列
   * @param options - 実行オプション（作業ディレクトリ、ツール制限等）
   * @returns エージェントの応答テキスト
   * @throws バックエンド固有のエラー（ネットワーク障害、認証エラー等）
   */
  run(prompt: string, options: AgentRunOptions): Promise<string>;
}

/**
 * Claude Code（query SDK）をラップする AgentBackend 実装。
 *
 * `@anthropic-ai/claude-agent-sdk` の `query()` は Claude Code のプログラマティック
 * インターフェースであり、CLI の `claude` コマンドと同等の機能を提供する。
 * 既存の runner-deps.ts / review/loop.ts と同じ呼び出しパターンに準拠している。
 *
 * このクラスがコードベース内で `query()` SDK を直接呼び出す唯一の場所となる。
 * 他のモジュールは必ず {@link AgentBackend} インターフェース経由で呼び出すこと。
 */
/**
 * AbortSignal を AbortController にラップする。
 * SDK は AbortController を受け取るため、外部から渡された AbortSignal を変換する必要がある。
 */
function wrapSignalAsController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

export class ClaudeBackend implements AgentBackend {
  async run(prompt: string, options: AgentRunOptions): Promise<string> {
    try {
      const queryOptions: QueryOptions = {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        allowedTools: options.allowedTools ?? ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: options.permissionMode ?? 'bypassPermissions',
        ...(options.abortSignal ? { abortController: wrapSignalAsController(options.abortSignal) } : {}),
      };

      let resultText: string | undefined;

      for await (const message of query({
        prompt,
        options: queryOptions,
      })) {
        if (message.type === 'result') {
          log.info('agent result', { subtype: message.subtype, phase: 'agent_execution' });
          if (message.subtype === 'success') {
            resultText = message.result;
          } else {
            const errors = 'errors' in message ? (message.errors as string[]) : [];
            throw new Error(
              `Claude Code execution ended with ${message.subtype}: ${errors.join('; ') || 'unknown error'}`,
            );
          }
        }
      }

      return resultText ?? '';
    } catch (error) {
      log.error('Claude Code execution failed', { error, phase: 'agent_execution' });
      throw error;
    }
  }
}

/**
 * AgentBackendConfig に基づいて AgentBackend インスタンスを生成するファクトリ関数。
 *
 * 新しいバックエンドを追加する際は、ここに `case` 分岐を追加する。
 * exhaustive check により、{@link AgentBackendType} に新しい値を追加した場合
 * コンパイルエラーで実装漏れを検出できる。
 *
 * @param backendConfig - バックエンド設定（type フィールドで種別を指定）
 * @returns 指定された type に対応する AgentBackend インスタンス
 */
export function createBackend(backendConfig: AgentBackendConfig): AgentBackend {
  switch (backendConfig.type) {
    case 'claude':
      return new ClaudeBackend();
    default: {
      // 型安全: 新しい type が追加された場合にコンパイルエラーになる
      const _exhaustive: never = backendConfig.type;
      throw new Error(`Unknown backend type: ${_exhaustive}`);
    }
  }
}
