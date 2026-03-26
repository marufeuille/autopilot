import {
  NotificationBackend,
  ApprovalResult,
  TaskFailureAction,
} from '../../notification/types';

/**
 * 記録された通知メッセージ
 */
export interface RecordedNotification {
  type: 'notify';
  message: string;
  storySlug?: string;
  timestamp: Date;
}

/**
 * 記録された承認リクエスト
 */
export interface RecordedApprovalRequest {
  type: 'requestApproval';
  id: string;
  message: string;
  buttons: { approve: string; reject: string };
  storySlug?: string;
  response: ApprovalResult;
  timestamp: Date;
}

/**
 * 記録されたTask失敗アクションリクエスト
 */
export interface RecordedTaskFailureRequest {
  type: 'requestTaskFailureAction';
  taskSlug: string;
  storySlug: string;
  errorSummary: string;
  response: TaskFailureAction;
  timestamp: Date;
}

export type RecordedEvent = RecordedNotification | RecordedApprovalRequest | RecordedTaskFailureRequest;

/**
 * FakeNotifier のオプション
 */
export interface FakeNotifierOptions {
  /**
   * 承認リクエストに対する応答キュー。
   * 先頭から順に消費される。キューが空になった場合はデフォルト動作（approve）を返す。
   */
  approvalResponses?: ApprovalResult[];
  /**
   * Task失敗アクションリクエストに対する応答キュー。
   * 先頭から順に消費される。キューが空になった場合はデフォルト動作（retry）を返す。
   */
  taskFailureResponses?: TaskFailureAction[];
}

/**
 * NotificationBackend のフェイク実装。
 *
 * - notify() はメッセージを記録するのみ
 * - requestApproval() は設定された応答キューから順に返す（デフォルトは approve）
 * - すべてのイベントは events プロパティに記録され、テストで検証可能
 */
export class FakeNotifier implements NotificationBackend {
  /** 記録されたすべてのイベント（notify と requestApproval） */
  public readonly events: RecordedEvent[] = [];

  /** 記録された通知メッセージのみ */
  public readonly notifications: RecordedNotification[] = [];

  /** 記録された承認リクエストのみ */
  public readonly approvalRequests: RecordedApprovalRequest[] = [];

  /** 記録されたTask失敗アクションリクエストのみ */
  public readonly taskFailureRequests: RecordedTaskFailureRequest[] = [];

  /** 記録されたスレッド開始呼び出し */
  public readonly threadStarts: Array<{ storySlug: string; message: string }> = [];

  /** アクティブなスレッドセッション（storySlug → fake thread_ts） */
  private readonly threadSessions = new Map<string, string>();

  private approvalQueue: ApprovalResult[];
  private taskFailureQueue: TaskFailureAction[];

  constructor(options?: FakeNotifierOptions) {
    this.approvalQueue = [...(options?.approvalResponses ?? [])];
    this.taskFailureQueue = [...(options?.taskFailureResponses ?? [])];
  }

  async notify(message: string, storySlug?: string): Promise<void> {
    const record: RecordedNotification = {
      type: 'notify',
      message,
      storySlug,
      timestamp: new Date(),
    };
    this.events.push(record);
    this.notifications.push(record);
  }

  async requestApproval(
    id: string,
    message: string,
    buttons: { approve: string; reject: string },
    storySlug?: string,
  ): Promise<ApprovalResult> {
    // キューから応答を取得。空ならデフォルト approve
    const response: ApprovalResult =
      this.approvalQueue.length > 0
        ? this.approvalQueue.shift()!
        : { action: 'approve' };

    const record: RecordedApprovalRequest = {
      type: 'requestApproval',
      id,
      message,
      buttons,
      storySlug,
      response,
      timestamp: new Date(),
    };
    this.events.push(record);
    this.approvalRequests.push(record);

    return response;
  }

  async requestTaskFailureAction(
    taskSlug: string,
    storySlug: string,
    errorSummary: string,
  ): Promise<TaskFailureAction> {
    // キューから応答を取得。空ならデフォルト retry
    const response: TaskFailureAction =
      this.taskFailureQueue.length > 0
        ? this.taskFailureQueue.shift()!
        : 'retry';

    const record: RecordedTaskFailureRequest = {
      type: 'requestTaskFailureAction',
      taskSlug,
      storySlug,
      errorSummary,
      response,
      timestamp: new Date(),
    };
    this.events.push(record);
    this.taskFailureRequests.push(record);

    return response;
  }

  /**
   * Task失敗応答キューに応答を追加する
   */
  enqueueTaskFailureResponse(...responses: TaskFailureAction[]): void {
    this.taskFailureQueue.push(...responses);
  }

  async startThread(storySlug: string, message: string): Promise<void> {
    this.threadStarts.push({ storySlug, message });
    // 既にセッションが存在する場合は上書きしない（ThreadSessionManager と同じガード）
    if (this.threadSessions.has(storySlug)) {
      return;
    }
    // fake thread_ts を生成してセッションに登録
    const fakeTs = `fake-thread-ts-${storySlug}-${Date.now()}`;
    this.threadSessions.set(storySlug, fakeTs);
  }

  getThreadTs(storySlug: string): string | undefined {
    return this.threadSessions.get(storySlug);
  }

  endSession(storySlug: string): void {
    this.threadSessions.delete(storySlug);
  }

  /**
   * 承認応答キューに応答を追加する
   */
  enqueueApprovalResponse(...responses: ApprovalResult[]): void {
    this.approvalQueue.push(...responses);
  }

  /**
   * 記録をクリアする
   */
  reset(): void {
    this.events.length = 0;
    this.notifications.length = 0;
    this.approvalRequests.length = 0;
    this.taskFailureRequests.length = 0;
    this.approvalQueue.length = 0;
    this.taskFailureQueue.length = 0;
    this.threadStarts.length = 0;
    this.threadSessions.clear();
  }
}
