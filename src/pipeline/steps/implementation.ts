import { FlowSignal, TaskContext } from '../types';
import { StoryFile, TaskFile } from '../../vault/reader';
import { formatReviewLoopResult } from '../../review';

/**
 * タスク実装のプロンプトを生成する
 */
function buildTaskPrompt(task: TaskFile, story: StoryFile, cwd: string, useWorktree: boolean): string {
  const prerequisite = useWorktree
    ? `- ワークツリーは既に feature/${task.slug} ブランチで作成済みです。直接作業してください。git checkout main や git pull は実行しないでください。`
    : `- mainブランチは最新の状態に同期済みです。git checkout main や git pull は不要です。直接 feature ブランチを作成してください。`;

  return `あなたは優秀なソフトウェアエンジニアです。以下のタスクを実装してください。

## ストーリー: ${story.slug}
${story.content}

## タスク: ${task.slug}
${task.content}

## 作業環境
- リポジトリパス: ${cwd}
- ブランチ名規則: feature/${task.slug}

## 前提条件
${prerequisite}

## 重要なルール
1. プロジェクトのCLAUDE.mdとREADMEを最初に読み、設計思想・規約に沿ってシンプルに実装すること。既存設計から逸脱した過剰な実装は避けること
2. 作業は必ず ${cwd} ディレクトリ内で行うこと
3. 実装には必ず対応するテストを作成すること。テストはユニットテストを基本とし、必要に応じて統合テストも書くこと。既存テストが壊れていないことも確認すること
4. 実装完了前に既存のテストスイートを実行し、既存テストが壊れていないことを確認すること
5. 実装が完了したらタスクの完了条件をすべて確認すること
6. PRの作成は自動で行われるため、\`gh pr create\` は実行しないこと
7. 実装完了後、最後に「実装完了」と出力すること

それでは実装を開始してください。`;
}

/**
 * retry時のプロンプトを生成する
 */
function buildRetryPrompt(task: TaskFile, cwd: string, reason: string, useWorktree: boolean): string {
  const branchInstruction = useWorktree
    ? `- ワークツリーは既に feature/${task.slug} ブランチで作成済みです。直接作業してください。git checkout main や git pull は実行しないでください。`
    : `- feature/${task.slug} ブランチが既に存在します。\`git checkout feature/${task.slug}\` してから作業を開始してください。git checkout main や新規ブランチ作成（git checkout -b）は不要です。`;

  return `前回の実装を修正してください。タスク: ${task.slug}\n\n${task.content}\n\n作業ディレクトリ: ${cwd}\n\n## 前提条件\n${branchInstruction}\n\n## 修正依頼\n${reason}\n\n## 重要\n- プロジェクトのCLAUDE.mdとREADMEを読み、設計思想・規約に沿ってシンプルに実装すること。既存設計から逸脱した過剰な実装は避けること\n- 実装には必ず対応するテストを作成すること。テストはユニットテストを基本とし、必要に応じて統合テストも書くこと。既存テストが壊れていないことも確認すること\n- 実装完了前に既存のテストスイートを実行し、既存テストが壊れていないことを確認すること\n- PRの作成は自動で行われるため、\`gh pr create\` は実行しないこと\n\n上記の修正依頼を踏まえて、完了条件を再確認しながら修正してください。`;
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
  const worktreePath = ctx.get('worktreePath');
  const cwd = worktreePath ?? repoPath;
  const useWorktree = worktreePath !== undefined;

  deps.updateFileStatus(task.filePath, 'Doing');

  const retryReason = ctx.getRetryReason();
  const rejectionReason = ctx.get('rejectionReason');

  let prompt = retryReason
    ? buildRetryPrompt(task, cwd, retryReason, useWorktree)
    : buildTaskPrompt(task, story, cwd, useWorktree);

  // 却下理由がある場合はプロンプトに追記
  if (rejectionReason) {
    prompt += `\n\n## 前回の却下理由\n${rejectionReason}\n上記の指摘を踏まえて実装してください。`;
    // 次回の implementation 実行時に残らないようクリア
    ctx.set('rejectionReason', undefined);
  }

  await deps.runAgent(prompt, cwd);

  const reviewResult = await deps.runReviewLoop(cwd, branch, task.content);
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
