import { FlowSignal, TaskContext } from '../types';

/**
 * Vault ストーリーノートへの why 記録プロンプトを生成する
 */
function buildVaultWhyPrompt(
  taskSlug: string,
  taskContent: string,
  storySlug: string,
  storyContent: string,
): string {
  return `あなたはドキュメント更新担当です。以下のタスク完了に伴い、Vault のストーリーノートに設計判断の記録を追記してください。

## 対象タスク
- ストーリー: ${storySlug}
- タスク: ${taskSlug}

## タスク内容
${taskContent}

## ストーリー内容
${storyContent}

## 作業内容

**Vault のストーリーノートに「なぜその設計か（why）」を追記する**
- 対象ストーリー: ${storySlug}
- 設計判断の背景・理由・トレードオフなど「why」を簡潔に記述する

## 重要な制約
- **実装の詳細（how）は書かない**: コードの具体的な実装方法、内部構造、アルゴリズムの詳細などは記述しない
- why（なぜその設計か）のみを記述すること
- 既存のドキュメント構造・フォーマットに合わせること
- 変更が不要と判断した場合は、無理に追記しなくてよい`;
}

/**
 * doc-update step
 *
 * タスク完了後に Vault ストーリーノートへ why を記録する。
 * README の更新は Story 単位で別途行うため、ここでは行わない。
 * localOnly モードでは Vault がないためスキップする。
 * エラーが発生してもパイプライン全体を止めず continue を返す。
 */
export async function handleDocUpdate(ctx: TaskContext): Promise<FlowSignal> {
  const { task, story, notifier, deps } = ctx;
  const localOnly = ctx.get('localOnly') ?? false;

  if (localOnly) {
    return { kind: 'continue' };
  }

  try {
    const prompt = buildVaultWhyPrompt(
      task.slug,
      task.content,
      story.slug,
      story.content,
    );

    await deps.runAgent(prompt, ctx.get('worktreePath') ?? ctx.repoPath);

    await notifier.notify(
      `📝 *Vault記録完了* (${task.slug})`,
      story.slug,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Vault記録に失敗しました: ${message}`);
    await notifier.notify(
      `⚠️ *Vault記録失敗* (${task.slug}): ${message}`,
      story.slug,
    ).catch(() => {});
  }

  return { kind: 'continue' };
}
