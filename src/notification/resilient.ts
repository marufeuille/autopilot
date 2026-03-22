/**
 * リジリエント通知バックエンド
 *
 * プライマリバックエンド（Slack等）での通知送信失敗時に、
 * リトライおよびフォールバック（ローカル通知）を提供する。
 */

import { NotificationBackend, ApprovalResult } from './types';
import { LocalNotificationBackend } from './local';

/** リトライ設定 */
export interface ResilientOptions {
  /** 最大リトライ回数（デフォルト: 2） */
  maxRetries?: number;
  /** リトライ間隔ミリ秒（デフォルト: 3000） */
  retryDelayMs?: number;
  /** フォールバック用 LocalNotificationBackend（DI用） */
  fallback?: NotificationBackend;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 3000;

/**
 * リジリエント通知バックエンド
 *
 * - notify: プライマリで失敗時にリトライ → フォールバック（ローカル通知）
 * - requestApproval: プライマリで失敗時にリトライ → フォールバック（ローカル承認）
 */
export class ResilientNotificationBackend implements NotificationBackend {
  private readonly primary: NotificationBackend;
  private readonly fallback: NotificationBackend;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(primary: NotificationBackend, options: ResilientOptions = {}) {
    this.primary = primary;
    this.fallback = options.fallback ?? new LocalNotificationBackend();
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async notify(message: string, storySlug?: string): Promise<void> {
    try {
      await this.withRetry(() => this.primary.notify(message, storySlug));
    } catch (error) {
      console.warn(
        `[resilient-notify] primary notify failed after ${this.maxRetries + 1} attempts, falling back to local:`,
        error instanceof Error ? error.message : error,
      );
      await this.fallback.notify(message, storySlug);
    }
  }

  async startThread(storySlug: string, message: string): Promise<void> {
    try {
      await this.withRetry(() => this.primary.startThread(storySlug, message));
    } catch (error) {
      console.warn(
        `[resilient-notify] primary startThread failed after ${this.maxRetries + 1} attempts, falling back to local:`,
        error instanceof Error ? error.message : error,
      );
      await this.fallback.startThread(storySlug, message);
    }
  }

  getThreadTs(storySlug: string): string | undefined {
    return this.primary.getThreadTs(storySlug);
  }

  endSession(storySlug: string): void {
    this.primary.endSession(storySlug);
  }

  async requestApproval(
    id: string,
    message: string,
    buttons: { approve: string; reject: string },
    storySlug?: string,
  ): Promise<ApprovalResult> {
    try {
      return await this.withRetry(() =>
        this.primary.requestApproval(id, message, buttons, storySlug),
      );
    } catch (error) {
      console.warn(
        `[resilient-notify] primary requestApproval failed after ${this.maxRetries + 1} attempts, falling back to local:`,
        error instanceof Error ? error.message : error,
      );
      return this.fallback.requestApproval(id, message, buttons, storySlug);
    }
  }

  /**
   * リトライ付きで処理を実行する
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        console.warn(
          `[resilient-notify] attempt ${attempt + 1}/${this.maxRetries + 1} failed:`,
          error instanceof Error ? error.message : error,
        );

        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }

    throw lastError;
  }

  /** テスト用にオーバーライド可能な sleep */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
