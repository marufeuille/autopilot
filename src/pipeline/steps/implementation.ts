import { FlowSignal, TaskContext } from '../types';
import { StoryFile, TaskFile } from '../../vault/reader';
import { formatReviewLoopResult } from '../../review';

/**
 * タスク実装のプロンプトを生成する
 */
function buildTaskPrompt(task: TaskFile, story: StoryFile, repoPath: string): string {
  return `あなたは優秀なソフトウェアエンジニアです。以下のタスクを実装してください。

## ストーリー: ${story.slug}
${story.content}

## タスク: ${task.slug}
${task.content}

## 作業環境
- リポジトリパス: ${repoPath}
- ブランチ名規則: feature/${task.slug}

## 前提条件
- mainブランチは最新の状態に同期済みです。git checkout main や git pull は不要です。直接 feature ブランチを作成してください。

## 重要なルール
1. 作業は必ず ${repoPath} ディレクトリ内で行うこと
2. 実装が完了したらタスクの完了条件をすべて確認すること
3. PRの作成は自動で行われるため、\`gh pr create\` は実行しないこと
4. 実装完了後、最後に「実装完了」と出力すること

それでは実装を開始してください。`;
}

/**
 * retry時のプロンプトを生成する
 */
function buildRetryPrompt(task: TaskFile, repoPath: string, reason: string): string {
  return `前回の実装を修正してください。タスク: ${task.slug}\n\n${task.content}\n\n作業ディレクトリ: ${repoPath}\n\n## 修正依頼\n${reason}\n\n上記の修正依頼を踏まえて、完了条件を再確認しながら修正してください。`;
}

/**
 * 実装 step（Agent実行 + セルフレビューループ）
 *
 * - retry理由があればretryプロンプト、なければ初回プロンプトでAgentを起動する
 * - レビューOK → reviewResultをcontextにセットして continue
 * - レビューNG → 通知して retry from: 'implementation'
 */
export async function handleImplementation(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, repoPath, notifier, deps } = ctx;
  const branch = `feature/${task.slug}`;

  const retryReason = ctx.getRetryReason();
  const prompt = retryReason
    ? buildRetryPrompt(task, repoPath, retryReason)
    : buildTaskPrompt(task, story, repoPath);

  await deps.runAgent(prompt, repoPath);

  const reviewResult = await deps.runReviewLoop(repoPath, branch, task.content);
  const reviewMessage = formatReviewLoopResult(reviewResult);

  if (reviewResult.finalVerdict === 'OK') {
    ctx.set('reviewResult', reviewResult);
    await notifier.notify(
      `*セルフレビュー結果* (${task.slug})\n\n${reviewMessage}`,
      story.slug,
    );
    return { kind: 'continue' };
  }

  // レビューNG: escalation有無にかかわらず通知してretry
  if (reviewResult.escalationRequired) {
    await notifier.notify(
      `⚠️ *セルフレビュー未通過（エスカレーション）*: ${task.slug}\n\n${reviewMessage}`,
      story.slug,
    );
  } else {
    await notifier.notify(
      `*セルフレビュー結果* (${task.slug})\n\n${reviewMessage}`,
      story.slug,
    );
  }

  return { kind: 'retry', from: 'implementation', reason: 'セルフレビュー未通過' };
}
