/**
 * Story 単位の README ドキュメント更新
 *
 * Story 完了時に README を更新すべきか Agent に判定させ、
 * 必要な場合のみ docs/story-[slug] ブランチで PR を作成する。
 */

import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StoryFile, TaskFile } from './vault/reader';
import { NotificationBackend } from './notification/types';
import { RunnerDeps } from './runner-deps';

/**
 * runStoryDocUpdate の戻り値
 */
export interface StoryDocUpdateResult {
  /** README 更新をスキップしたかどうか */
  skipped: boolean;
  /** 作成された PR の URL（更新時のみ） */
  prUrl?: string;
}

/**
 * slug をブランチ名・コマンド引数に安全に使える形式にサニタイズする。
 * 英数字、ハイフン、アンダースコア、スラッシュ、ドットのみ許可。
 */
export function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9\-_./]/g, '');
}

/**
 * Agent に渡す README 更新判定・実行プロンプトを生成する
 */
function buildReadmeUpdatePrompt(
  story: StoryFile,
  tasks: TaskFile[],
): string {
  const taskSummaries = tasks
    .map((t) => `### ${t.slug}\n${t.content}`)
    .join('\n\n');

  return `あなたはドキュメント更新担当です。以下のストーリー完了に伴い、リポジトリの README.md を更新すべきか判断し、必要な場合のみ更新してください。

## ストーリー
- slug: ${story.slug}
${story.content}

## 完了したタスク一覧
${taskSummaries}

## README 更新基準

README は「使う人・開発者全員が知るべき why/what」のみ記載します。

| 更新する | 更新しない |
|---|---|
| 処理フロー・振る舞いが変わった | リファクタで内部構造が変わっただけ |
| 新しいユーザー向け機能が増えた | コードの整理・命名変更 |
| 設計判断の理由が将来の開発者に必要 | 実装詳細・アルゴリズム |

## 作業手順

1. リポジトリの README.md を読む
2. 上記の基準に照らして、更新が必要かどうか判断する
3. **更新が必要な場合のみ** README.md を編集する
4. **更新不要の場合は何も変更しない**（リファクタのみ、内部構造の変更のみ等）

## 重要な制約
- 実装の詳細（how）は書かない
- 既存のドキュメント構造・フォーマットに合わせること
- 不要な変更は一切加えないこと`;
}

/**
 * PR 本文を生成する
 */
function buildPRBody(story: StoryFile, tasks: TaskFile[]): string {
  const taskList = tasks.map((t) => `- \`${t.slug}\``).join('\n');
  return `## 概要\n\nストーリー \`${story.slug}\` の完了に伴う README 更新です。\n\n## 対象タスク\n${taskList}`;
}

/**
 * Story 完了時に README を更新すべきか判定し、必要な場合のみ PR を作成する。
 *
 * フロー:
 * 1. main ブランチを最新化
 * 2. docs/story-[slug] ブランチを作成
 * 3. Agent に README 更新の要否判定 + 実行を委ねる
 * 4. git diff で変更有無を確認
 *    - 変更なし → ブランチ削除、skipped: true を返す
 *    - 変更あり → commit, push, gh pr create で PR を作成
 */
export async function runStoryDocUpdate(
  story: StoryFile,
  tasks: TaskFile[],
  repoPath: string,
  notifier: NotificationBackend,
  deps: RunnerDeps,
): Promise<StoryDocUpdateResult> {
  const safeSlug = sanitizeSlug(story.slug);
  if (!safeSlug) {
    throw new Error(`Invalid story slug: ${story.slug}`);
  }
  const branch = `docs/story-${safeSlug}`;

  try {
    // main ブランチで最新状態にする
    await deps.syncMainBranch(repoPath);

    // docs ブランチを作成
    deps.execCommand(`git checkout -b ${branch}`, repoPath);

    // Agent に README 更新を判断・実行させる
    const prompt = buildReadmeUpdatePrompt(story, tasks);
    await deps.runAgent(prompt, repoPath);

    // Agent が何か変更したかチェック（staged + unstaged 両方を検出）
    const diff = deps.execCommand('git status --porcelain', repoPath).trim();

    if (!diff) {
      // 変更なし → ブランチを削除してスキップ
      deps.execCommand('git checkout main', repoPath);
      deps.execCommand(`git branch -D ${branch}`, repoPath);
      console.log(`[story-doc-update] README 更新不要と判断: ${story.slug}`);
      return { skipped: true };
    }

    // README.md 以外の変更がある場合は元に戻す
    const changedFiles = diff.split('\n').map((line) => line.trim().split(/\s+/).pop() ?? '');
    const nonReadmeFiles = changedFiles.filter((f) => f !== 'README.md');
    if (nonReadmeFiles.length > 0) {
      // README.md 以外の変更をリセット
      for (const file of nonReadmeFiles) {
        try {
          deps.execCommand(`git checkout -- ${file}`, repoPath);
        } catch { /* 新規ファイルの場合は checkout できない */ }
        try {
          deps.execCommand(`git clean -f -- ${file}`, repoPath);
        } catch { /* ignore */ }
      }
    }

    // README.md のみをステージング
    deps.execCommand('git add README.md', repoPath);

    // README.md に実際の変更があるか再確認
    const stagedDiff = deps.execCommand('git diff --cached --name-only', repoPath).trim();
    if (!stagedDiff) {
      deps.execCommand('git checkout main', repoPath);
      deps.execCommand(`git branch -D ${branch}`, repoPath);
      console.log(`[story-doc-update] README 更新不要と判断（README以外の変更のみ）: ${story.slug}`);
      return { skipped: true };
    }

    deps.execCommand(
      `git commit -m "docs: update README for story ${safeSlug}"`,
      repoPath,
    );
    deps.execCommand(`git push -u origin ${branch}`, repoPath);

    // PR 作成（タイトル・本文とも一時ファイル経由でシェルインジェクションを防ぐ）
    const title = `docs: README更新 - ${safeSlug}`;
    const body = buildPRBody(story, tasks);
    const tmpBodyFile = join(tmpdir(), `autopilot-doc-pr-body-${Date.now()}.md`);
    const tmpTitleFile = join(tmpdir(), `autopilot-doc-pr-title-${Date.now()}.txt`);

    try {
      writeFileSync(tmpBodyFile, body, 'utf-8');
      writeFileSync(tmpTitleFile, title, 'utf-8');
      const prUrl = deps.execGh(
        ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body-file', tmpBodyFile],
        repoPath,
      ).trim();
      console.log(`[story-doc-update] PR 作成完了: ${prUrl}`);
      return { skipped: false, prUrl };
    } finally {
      try { unlinkSync(tmpBodyFile); } catch { /* ignore */ }
      try { unlinkSync(tmpTitleFile); } catch { /* ignore */ }
    }
  } catch (error) {
    // エラー時は main に戻す（ベストエフォート）
    try {
      deps.execCommand('git checkout main', repoPath);
    } catch { /* ignore */ }
    throw error;
  }
}
