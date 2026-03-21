import { execFile } from 'child_process';
import * as readline from 'readline';
import { NotificationBackend, ApprovalResult, LocalBackendOptions } from './types';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5分

/**
 * ローカル通知バックエンド
 *
 * - notify: macOS システム通知（osascript）を送信
 * - requestApproval: macOS 通知 + ターミナル stdin で y/n 承認
 */
export class LocalNotificationBackend implements NotificationBackend {
  private readonly timeoutMs: number;
  /** テスト用: readline.Interface を外部から注入可能 */
  public _createReadlineInterface: () => readline.Interface;

  constructor(options: LocalBackendOptions = {}) {
    this.timeoutMs = options.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._createReadlineInterface = () =>
      readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  /**
   * macOS システム通知を送信する
   */
  async notify(message: string): Promise<void> {
    return new Promise<void>((resolve) => {
      execFile(
        'osascript',
        ['-e', `display notification "${escapeAppleScript(message)}" with title "Autopilot"`],
        (err) => {
          if (err) {
            console.warn('[local-notify] osascript failed, falling back to console:', err.message);
          }
          // osascript が失敗してもコンソール出力は行う
          resolve();
        },
      );
      console.log(`[notify] ${message}`);
    });
  }

  /**
   * 承認リクエスト: macOS 通知を送りつつターミナルで y/n を待つ
   */
  async requestApproval(
    _id: string,
    message: string,
    buttons: { approve: string; reject: string },
  ): Promise<ApprovalResult> {
    // macOS 通知で承認リクエストがある旨を通知
    await this.notify(`承認リクエスト: ${stripMarkdown(message).slice(0, 100)}`);

    return this.promptTerminal(message, buttons);
  }

  /**
   * ターミナルの標準入力で y/n 承認を受け付ける
   */
  private promptTerminal(
    message: string,
    buttons: { approve: string; reject: string },
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const rl = this._createReadlineInterface();
      let settled = false;

      const settle = (result: ApprovalResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl.close();
        resolve(result);
      };

      // タイムアウト
      const timer = setTimeout(() => {
        console.log('\n[approval] タイムアウトしました。自動的に却下します。');
        settle({ action: 'reject', reason: 'タイムアウト' });
      }, this.timeoutMs);

      // プロンプト表示
      console.log('\n' + '='.repeat(60));
      console.log('📋 承認リクエスト');
      console.log('='.repeat(60));
      console.log(stripMarkdown(message));
      console.log('-'.repeat(60));

      rl.question(
        `[${buttons.approve}] y/yes | [${buttons.reject}] その他\n> `,
        (answer: string) => {
          const normalized = answer.trim().toLowerCase();
          if (normalized === 'y' || normalized === 'yes') {
            settle({ action: 'approve' });
          } else {
            // reject の場合は理由を聞く
            rl.question('理由を入力してください（省略可）: ', (reason: string) => {
              settle({ action: 'reject', reason: reason.trim() || '却下' });
            });
          }
        },
      );
    });
  }
}

/** AppleScript 文字列のエスケープ */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Slack mrkdwn 記法を簡易除去 */
function stripMarkdown(text: string): string {
  return text.replace(/\*/g, '').replace(/`/g, '');
}
