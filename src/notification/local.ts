import { execFile } from 'child_process';
import * as readline from 'readline';
import { NotificationBackend, ApprovalResult, TaskFailureAction, AcceptanceCheckResult, AcceptanceGateAction } from './types';

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
  async notify(message: string, _storySlug?: string, _options?: import('./types').NotifyOptions): Promise<void> {
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
    buttons: { approve: string; reject: string; cancel?: string },
    _storySlug?: string,
  ): Promise<ApprovalResult> {
    // macOS 通知で承認リクエストがある旨を通知
    await this.notify(`承認リクエスト: ${stripMarkdown(message).slice(0, 100)}`);

    return this.promptTerminal(message, buttons);
  }

  /**
   * Task失敗時にターミナルで判断を受け付ける
   *
   * requestApproval を再利用し、ApprovalResult → TaskFailureAction にマッピングする。
   */
  async requestTaskFailureAction(
    taskSlug: string,
    storySlug: string,
    errorSummary: string,
  ): Promise<TaskFailureAction> {
    const message =
      `❌ *タスク失敗*: \`${taskSlug}\`\n` +
      `*ストーリー*: \`${storySlug}\`\n` +
      `*エラー*: ${errorSummary}\n\n` +
      `対応を選択してください。`;

    const result = await this.requestApproval(
      `failure-${taskSlug}`,
      message,
      { approve: 'リトライ', reject: 'スキップして次へ', cancel: 'ストーリーをキャンセル' },
    );

    switch (result.action) {
      case 'approve':
        return 'retry';
      case 'reject':
        return 'skip';
      case 'cancel':
        return 'cancel';
    }
  }

  /**
   * 受け入れ条件ゲートのアクション選択
   *
   * requestApproval を再利用し、ApprovalResult → AcceptanceGateAction にマッピングする。
   * allPassed の場合は approve → done、reject は不使用。
   * 一部FAIL の場合は approve → force_done、reject → comment（理由をテキストとして返す）。
   */
  async requestAcceptanceGateAction(
    storySlug: string,
    checkResult: AcceptanceCheckResult,
  ): Promise<AcceptanceGateAction> {
    const conditionLines = checkResult.conditions.map((c) => {
      const icon = c.passed ? '✅' : '❌';
      return `${icon} ${c.condition}: ${c.reason}`;
    });

    const headerText = checkResult.allPassed
      ? '受け入れ条件チェック: 全条件 PASS'
      : '受け入れ条件チェック: 一部 FAIL';

    const message =
      `*${headerText}*\n*ストーリー*: \`${storySlug}\`\n\n` +
      conditionLines.join('\n');

    if (checkResult.allPassed) {
      const result = await this.requestApproval(
        `acceptance-${storySlug}`,
        message,
        { approve: 'Story を Done にする', reject: 'キャンセル' },
      );
      if (result.action === 'approve') {
        return { action: 'done' };
      }
      throw new Error('受け入れゲートがキャンセルされました');
    }

    const result = await this.requestApproval(
      `acceptance-${storySlug}`,
      message,
      { approve: 'このまま Done にする', reject: 'コメントして追加タスクを作る' },
    );

    if (result.action === 'approve') {
      return { action: 'force_done' };
    }
    return { action: 'comment', text: result.action === 'reject' ? result.reason : '' };
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
    buttons: { approve: string; reject: string; cancel?: string },
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const rl = this._createReadlineInterface();

      // プロンプト表示
      console.log('\n' + '='.repeat(60));
      console.log('📋 承認リクエスト');
      console.log('='.repeat(60));
      console.log(stripMarkdown(message));
      console.log('-'.repeat(60));

      const promptParts = [`[${buttons.approve}] y/yes`];
      if (buttons.cancel) {
        promptParts.push(`[${buttons.cancel}] c/cancel`);
      }
      promptParts.push(`[${buttons.reject}] その他`);

      rl.question(
        `${promptParts.join(' | ')}\n> `,
        (answer: string) => {
          const normalized = answer.trim().toLowerCase();
          if (normalized === 'y' || normalized === 'yes') {
            rl.close();
            resolve({ action: 'approve' });
          } else if (buttons.cancel && (normalized === 'c' || normalized === 'cancel')) {
            rl.close();
            resolve({ action: 'cancel' });
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
