/**
 * 対話型コマンドのセッション管理モジュール
 *
 * /ap story, /ap fix などの対話型コマンドで、
 * Slack スレッドごとのセッション状態（フェーズ、会話履歴など）を管理する。
 *
 * notification/thread-session.ts の ThreadSessionManager が storySlug → thread_ts の
 * 1:1マッピングを管理するのに対し、このモジュールはスレッド起点の対話セッションを
 * phase やコンテキスト情報とともに追跡する。
 */
import { logInfo, logWarn } from '../logger';

/** セッションのフェーズ */
export type SessionPhase = 'drafting' | 'approved' | 'executing' | 'completed' | 'cancelled';

/** セッションの種別 */
export type SessionType = 'story' | 'fix';

/** 会話メッセージ */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 対話型セッションの状態 */
export interface InteractiveSession {
  /** スレッドの起点メッセージの timestamp */
  threadTs: string;
  /** チャンネルID */
  channelId: string;
  /** セッション種別 */
  type: SessionType;
  /** 現在のフェーズ */
  phase: SessionPhase;
  /** ユーザーが最初に入力した説明文 */
  description: string;
  /** 会話履歴（マルチターン用） */
  conversationHistory: ConversationMessage[];
}

/**
 * 対話型セッションマネージャー
 *
 * threadTs をキーにセッション状態を管理する。
 * スレッド内のメッセージイベントからセッションを引き当て、
 * マルチターン会話を実現する基盤を提供する。
 */
export class InteractiveSessionManager {
  private readonly sessions = new Map<string, InteractiveSession>();

  /**
   * 新しいセッションを開始する
   */
  startSession(session: InteractiveSession): void {
    this.sessions.set(session.threadTs, session);
    logInfo('セッション開始', {
      command: session.type,
      threadTs: session.threadTs,
      phase: session.phase,
    });
  }

  /**
   * threadTs に対応するセッションを取得する
   */
  getSession(threadTs: string): InteractiveSession | undefined {
    return this.sessions.get(threadTs);
  }

  /**
   * セッションのフェーズを更新する
   */
  updatePhase(threadTs: string, phase: SessionPhase): void {
    const session = this.sessions.get(threadTs);
    if (session) {
      const previousPhase = session.phase;
      session.phase = phase;
      logInfo('セッションフェーズ更新', {
        command: session.type,
        threadTs,
        phase,
        previousPhase,
      });
    } else {
      logWarn('セッションが見つからないためフェーズ更新をスキップ', {
        threadTs,
        phase,
      });
    }
  }

  /**
   * セッションのフェーズを Compare-and-Swap で更新する
   *
   * 現在の phase が expectedPhase と一致する場合のみ newPhase に遷移し true を返す。
   * 一致しない場合やセッションが存在しない場合は false を返す。
   * これにより、承認ボタンの二重押下などの競合状態を防止できる。
   */
  compareAndSwapPhase(
    threadTs: string,
    expectedPhase: SessionPhase,
    newPhase: SessionPhase,
  ): boolean {
    const session = this.sessions.get(threadTs);
    if (!session || session.phase !== expectedPhase) {
      logWarn('CAS フェーズ遷移失敗', {
        threadTs,
        expectedPhase,
        newPhase,
        actualPhase: session?.phase ?? '(session not found)',
      });
      return false;
    }
    session.phase = newPhase;
    logInfo('CAS フェーズ遷移成功', {
      command: session.type,
      threadTs,
      phase: `${expectedPhase} → ${newPhase}`,
    });
    return true;
  }

  /**
   * 会話履歴にメッセージを追加する
   */
  addMessage(threadTs: string, message: ConversationMessage): void {
    const session = this.sessions.get(threadTs);
    if (session) {
      session.conversationHistory.push(message);
      logInfo('会話履歴にメッセージ追加', {
        command: session.type,
        threadTs,
        role: message.role,
        historyLength: session.conversationHistory.length,
      });
    }
  }

  /**
   * セッションを終了する
   */
  endSession(threadTs: string): void {
    const session = this.sessions.get(threadTs);
    if (session) {
      logInfo('セッション終了', {
        command: session.type,
        threadTs,
        phase: session.phase,
      });
    }
    this.sessions.delete(threadTs);
  }

  /**
   * アクティブなセッション数を返す
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * アクティブなセッション一覧を返す（デバッグ・運用時の状態確認用）
   */
  listActiveSessions(): Array<{
    threadTs: string;
    type: SessionType;
    phase: SessionPhase;
    channelId: string;
    historyLength: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      threadTs: s.threadTs,
      type: s.type,
      phase: s.phase,
      channelId: s.channelId,
      historyLength: s.conversationHistory.length,
    }));
  }
}

/** シングルトンインスタンス */
export const interactiveSessionManager = new InteractiveSessionManager();
