/**
 * 通知バックエンドのインターフェース定義
 *
 * すべての通知バックエンド（local, slack など）はこのインターフェースを実装する。
 */

/** 承認リクエストの結果 */
export type ApprovalResult =
  | { action: 'approve' }
  | { action: 'reject'; reason: string }
  | { action: 'cancel' };

/** Task失敗時のユーザー選択肢 */
export type TaskFailureAction = 'retry' | 'skip' | 'cancel';

/** Story失敗時のキュー操作アクション */
export type QueueFailedAction = 'resume' | 'retry' | 'clear';

/** 受け入れ条件チェックの個別結果 */
export interface AcceptanceConditionResult {
  /** 条件テキスト */
  condition: string;
  /** PASS / FAIL */
  passed: boolean;
  /** 理由 */
  reason: string;
}

/** 受け入れ条件チェック全体の結果 */
export interface AcceptanceCheckResult {
  /** 全条件の結果 */
  conditions: AcceptanceConditionResult[];
  /** 全条件PASSかどうか */
  allPassed: boolean;
}

/** 受け入れ条件ゲートのユーザー選択結果 */
export type AcceptanceGateAction =
  | { action: 'done' }
  | { action: 'force_done' }
  | { action: 'comment'; text: string };

import type { Block, KnownBlock } from '@slack/types';

/** notify のオプション */
export interface NotifyOptions {
  /** Block Kit ブロック配列（Slack バックエンドでのみ有効） */
  blocks?: ReadonlyArray<KnownBlock | Block>;
}

/** 通知バックエンドが実装すべきインターフェース */
export interface NotificationBackend {
  /**
   * 通知を送信する（情報通知、完了通知など）
   * @param message 通知メッセージ
   * @param storySlug ストーリー識別子（指定時はスレッド内に投稿）
   * @param options 追加オプション（Block Kit ブロック等）
   */
  notify(message: string, storySlug?: string, options?: NotifyOptions): Promise<void>;

  /**
   * 承認リクエストを送信し、結果を待つ
   * @param id 承認リクエストの一意識別子
   * @param message 承認プロンプトに表示するメッセージ
   * @param buttons ボタンラベル（approve / reject）
   * @param storySlug ストーリー識別子（指定時はスレッド内に投稿）
   * @returns 承認結果
   */
  requestApproval(
    id: string,
    message: string,
    buttons: { approve: string; reject: string; cancel?: string },
    storySlug?: string,
  ): Promise<ApprovalResult>;

  /**
   * スレッドセッションを開始する
   *
   * story 実行開始時にスレッドの起点メッセージを投稿し、
   * 以降の通知・承認依頼をそのスレッド内に展開するための基盤を作る。
   *
   * @param storySlug ストーリーの識別子
   * @param message スレッド起点メッセージ
   */
  startThread(storySlug: string, message: string): Promise<void>;

  /**
   * storySlug に対応するスレッドの thread_ts を取得する
   *
   * @param storySlug ストーリーの識別子
   * @returns thread_ts（セッション未開始の場合は undefined）
   */
  getThreadTs(storySlug: string): string | undefined;

  /**
   * スレッドセッションを終了する
   *
   * story 完了時に呼び出し、storySlug に紐づくスレッド情報を破棄する。
   *
   * @param storySlug ストーリーの識別子
   */
  endSession(storySlug: string): void;

  /**
   * Task失敗時にユーザーへ判断を委ね、選択結果を返す
   *
   * ストーリースレッドにボタン付き通知を送信し、
   * 「リトライ / スキップして次へ / ストーリーをキャンセル」の選択を待つ。
   *
   * @param taskSlug 失敗したタスクの識別子
   * @param storySlug ストーリーの識別子
   * @param errorSummary エラーの概要
   * @returns ユーザーが選択したアクション
   */
  requestTaskFailureAction(
    taskSlug: string,
    storySlug: string,
    errorSummary: string,
  ): Promise<TaskFailureAction>;

  /**
   * 受け入れ条件ゲートの結果を通知し、ユーザーの判断を待つ
   *
   * ストーリースレッドにチェック結果（各条件の PASS/FAIL と理由）を投稿し、
   * 全条件PASSの場合は「Story を Done にする」ボタンを、
   * 一部FAILの場合は「このまま Done にする」「コメントして追加タスクを作る」ボタンを表示する。
   *
   * @param storySlug ストーリーの識別子
   * @param checkResult 受け入れ条件チェック結果
   * @returns ユーザーが選択したアクション
   */
  requestAcceptanceGateAction(
    storySlug: string,
    checkResult: AcceptanceCheckResult,
  ): Promise<AcceptanceGateAction>;
}

/**
 * 通知イベントの種別
 */
export type NotificationEventType =
  | 'merge_approval'      // CI通過後のマージ承認依頼
  | 'review_escalation'   // レビューNG上限到達によるエスカレーション
  | 'ci_escalation'       // CI失敗上限到達によるエスカレーション
  | 'review_result'       // セルフレビュー結果（情報通知）
  | 'ci_result';          // CI結果（情報通知）

/**
 * マージ条件の検証項目
 */
export interface MergeConditionItem {
  /** 条件を満たしているかどうか */
  passed: boolean;
  /** 条件のラベル */
  label: string;
}

/**
 * 構造化された通知コンテキスト
 */
export interface NotificationContext {
  /** 通知イベント種別 */
  eventType: NotificationEventType;
  /** タスク slug */
  taskSlug: string;
  /** ストーリー slug */
  storySlug: string;
  /** PR URL（作成済みの場合） */
  prUrl?: string;
  /** レビューサマリー */
  reviewSummary?: string;
  /** CI結果サマリー */
  ciSummary?: string;
  /** CI実行URL */
  ciRunUrl?: string;
  /** マージ条件の検証結果一覧 */
  mergeConditions?: MergeConditionItem[];
  /** マージ条件をすべて満たしているか */
  mergeReady?: boolean;
}
