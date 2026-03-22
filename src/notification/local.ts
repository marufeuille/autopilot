import { execFile } from 'child_process';
import * as readline from 'readline';
import { NotificationBackend, ApprovalResult } from './types';

/**
 * ローカル通知バックエンド
 *
 * - notify: macOS システム通知（osascript）を送信
 * - requestApproval: macOS 通知 + ターミナル stdin で y/n 承認（無制限待機）
 */
export class LocalNotificationBackend implements NotificationBackend {
  /** テスト用: readline.Interface を外部から注入可能 */
  public _createReadlineInterface: () => readline.Interface;

  constructor() {
    this._createReadlineInterface = () =>
      readline.createInterface({ input: process.stdin, output: process.stdout });
  }

  /**
   * macOS システム通知を送信する
   */
  async notify(message: string, _storySlug?: string): Promise<void> {
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
    _storySlug?: string,
  ): Promise<ApprovalResult> {
    // macOS 通知で承認リクエストがある旨を通知
    await this.notify(`承認リクエスト: ${stripMarkdown(message).slice(0, 100)}`);

    return this.promptTerminal(message, buttons);
  }

  /**
   * スレッドセッションを開始する（ローカルでは no-op）
   */
  async startThread(_storySlug: string, _message: string): Promise<void> {
    // ローカルバックエンドではスレッドの概念がないため何もしない
  }

  /**
   * スレッドの thread_ts を取得する（ローカルでは常に undefined）
   */
  getThreadTs(_storySlug: string): string | undefined {
    return undefined;
  }

  /**
   * スレッドセッションを終了する（ローカルでは no-op）
   */
  endSession(_storySlug: string): void {
    // ローカルバックエンドではスレッドの概念がないため何もしない
  }

  /**
   * ターミナルの標準入力で y/n 承認を受け付ける（無制限待機）
   *
   * ターミナル操作は人間が行うため、タイムアウトは設けない。
   * 人間が離席中に勝手に却下されるのは望ましくないため、入力があるまで待ち続ける。
   */
  private promptTerminal(
    message: string,
    buttons: { approve: string; reject: string },
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const rl = this._createReadlineInterface();

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
            rl.close();
            resolve({ action: 'approve' });
          } else {
            // reject の場合は理由を聞く
            rl.question('理由を入力してください（省略可）: ', (reason: string) => {
              rl.close();
              resolve({ action: 'reject', reason: reason.trim() || '却下' });
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
