import { FlowSignal, TaskContext } from '../types';

/**
 * ドキュメント更新プロンプトを生成する
 *
 * localOnly モードの場合は Vault 更新をスキップし README のみ対象とする。
 */
function buildDocUpdatePrompt(
  taskSlug: string,
  taskContent: string,
  storySlug: string,
  storyContent: string,
  cwd: string,
  localOnly: boolean,
): string {
  const vaultSection = localOnly
    ? ''
    : `
2. **Vault のストーリーノートに「なぜその設計か（why）」を追記する**
   - 対象ストーリー: ${storySlug}
   - 設計判断の背景・理由・トレードオフなど「why」を簡潔に記述する`;

  const targetSummary = localOnly
    ? 'Repository README のみを対象とします（Vault 更新はスキップ）。'
    : 'Repository README と Vault のストーリーノートを対象とします。';

  return `あなたはドキュメント更新担当です。以下のタスク完了に伴い、ドキュメントを更新してください。

## 対象タスク
- ストーリー: ${storySlug}
- タスク: ${taskSlug}

## タスク内容
${taskContent}

## ストーリー内容
${storyContent}

## 作業ディレクトリ
${cwd}

## 更新対象
${targetSummary}

## 更新ルール

1. **Repository README に「何をするか（what）」を追記する**
   - このタスクで追加・変更された機能や振る舞いを、ユーザー・開発者向けに簡潔に記述する
${vaultSection}

## 重要な制約
- **実装の詳細（how）は書かない**: コードの具体的な実装方法、内部構造、アルゴリズムの詳細などは記述しない。これらは陳腐化しやすいため、ソースコードを正とする
- what（何をするか）と why（なぜその設計か）のみを記述すること
- 既存のドキュメント構造・フォーマットに合わせること
- 変更が不要と判断した場合は、無理に追記しなくてよい`;
}

/**
 * doc-update step
 *
 * タスク完了後にドキュメント（README / Vault ストーリーノート）を更新する。
 * エラーが発生してもパイプライン全体を止めず continue を返す。
 */
export async function handleDocUpdate(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, repoPath, notifier, deps } = ctx;
  const worktreePath = ctx.get('worktreePath');
  const cwd = worktreePath ?? repoPath;
  const localOnly = ctx.get('localOnly') ?? false;

  try {
    const prompt = buildDocUpdatePrompt(
      task.slug,
      task.content,
      story.slug,
      story.content,
      cwd,
      localOnly,
    );

    await deps.runAgent(prompt, cwd);

    await notifier.notify(
      `📝 *ドキュメント更新完了* (${task.slug})`,
      story.slug,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`ドキュメント更新に失敗しました: ${message}`);
    await notifier.notify(
      `⚠️ *ドキュメント更新失敗* (${task.slug}): ${message}`,
      story.slug,
    ).catch(() => {});
  }

  return { kind: 'continue' };
}
