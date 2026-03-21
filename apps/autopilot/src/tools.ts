import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { App } from '@slack/bolt';
import Anthropic from '@anthropic-ai/sdk';
import { requestApproval, generateApprovalId, ApprovalResult } from './approval';
import { updateFileStatus } from './vault/writer';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'ファイルの内容を読み込む',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '読み込むファイルのパス' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'ファイルに内容を書き込む（ディレクトリが存在しない場合は作成する）',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: '書き込むファイルのパス' },
        content: { type: 'string', description: '書き込む内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'シェルコマンドを実行する。git操作・テスト・ビルドなどに使用する',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: '実行するコマンド' },
        cwd: { type: 'string', description: '作業ディレクトリ（省略時はリポジトリルート）' },
      },
      required: ['command'],
    },
  },
  {
    name: 'request_approval',
    description: '人間にSlack経由で承認を求める。重要な決断の前に使用する',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Slackに送るメッセージ（mrkdwn形式）' },
        approve_label: { type: 'string', description: '承認ボタンのラベル（例: 承認・完了）' },
        reject_label: { type: 'string', description: '却下ボタンのラベル（例: スキップ・やり直し）' },
      },
      required: ['message', 'approve_label', 'reject_label'],
    },
  },
  {
    name: 'update_vault_status',
    description: 'Vaultのタスクまたはストーリーファイルのstatusを更新する',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: '更新するファイルの絶対パス' },
        status: { type: 'string', description: '新しいstatus（Todo/Doing/Done）' },
      },
      required: ['file_path', 'status'],
    },
  },
];

export interface ToolContext {
  app: App;
  repoPath: string;
  storySlug: string;
  taskSlug: string;
}

export async function executeTool(
  toolName: string,
  toolInput: Record<string, string>,
  ctx: ToolContext,
): Promise<string> {
  try {
    switch (toolName) {
      case 'read_file': {
        const content = fs.readFileSync(toolInput.path, 'utf-8');
        return content;
      }

      case 'write_file': {
        const dir = path.dirname(toolInput.path);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(toolInput.path, toolInput.content, 'utf-8');
        return `ファイルを書き込みました: ${toolInput.path}`;
      }

      case 'run_command': {
        const cwd = toolInput.cwd ?? ctx.repoPath;
        const output = execSync(toolInput.command, {
          cwd,
          timeout: 120_000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output || '(出力なし)';
      }

      case 'request_approval': {
        const id = generateApprovalId(ctx.storySlug, ctx.taskSlug);
        const result: ApprovalResult = await requestApproval(
          ctx.app,
          id,
          toolInput.message,
          { approve: toolInput.approve_label, reject: toolInput.reject_label },
        );
        return result;
      }

      case 'update_vault_status': {
        updateFileStatus(toolInput.file_path, toolInput.status);
        return `status を ${toolInput.status} に更新しました: ${toolInput.file_path}`;
      }

      default:
        return `未知のツール: ${toolName}`;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `エラー: ${message}`;
  }
}
