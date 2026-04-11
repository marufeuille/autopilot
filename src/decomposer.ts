import { StoryFile } from './vault/reader';
import { TaskDraft } from './vault/writer';
import { ClaudeBackend } from './agent/backend';
import type { AgentBackend } from './agent/backend';

// --- バリデーション ---

const VALID_PRIORITIES = ['high', 'medium', 'low'] as const;
const VALID_EFFORTS = ['low', 'medium', 'high'] as const;
const REQUIRED_FIELDS = ['slug', 'title', 'priority', 'effort', 'purpose', 'detail', 'criteria'] as const;
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateTaskDrafts(data: unknown, storySlug: string): TaskDraft[] {
  if (!Array.isArray(data)) {
    throw new Error('タスク分解の出力が配列ではありません');
  }

  if (data.length === 0) {
    throw new Error('タスク分解の結果が空です。1つ以上のタスクが必要です');
  }

  const errors: string[] = [];

  data.forEach((item: unknown, index: number) => {
    const prefix = `tasks[${index}]`;

    if (typeof item !== 'object' || item === null) {
      errors.push(`${prefix}: オブジェクトではありません`);
      return;
    }

    const obj = item as Record<string, unknown>;

    // 必須フィールドの存在チェック
    for (const field of REQUIRED_FIELDS) {
      if (!(field in obj)) {
        errors.push(`${prefix}: 必須フィールド "${field}" がありません`);
      }
    }

    // slug の検証
    if ('slug' in obj) {
      if (typeof obj.slug !== 'string') {
        errors.push(`${prefix}.slug: 文字列ではありません`);
      } else {
        if (!KEBAB_CASE_RE.test(obj.slug)) {
          errors.push(`${prefix}.slug: kebab-case ではありません ("${obj.slug}")`);
        }
        if (!obj.slug.startsWith(`${storySlug}-`)) {
          errors.push(`${prefix}.slug: "${storySlug}-" で始まっていません ("${obj.slug}")`);
        }
      }
    }

    // title の型チェック
    if ('title' in obj && typeof obj.title !== 'string') {
      errors.push(`${prefix}.title: 文字列ではありません`);
    }

    // priority の値域チェック
    if ('priority' in obj) {
      if (typeof obj.priority !== 'string' || !(VALID_PRIORITIES as readonly string[]).includes(obj.priority)) {
        errors.push(`${prefix}.priority: "high" | "medium" | "low" のいずれかである必要があります ("${obj.priority}")`);
      }
    }

    // effort の値域チェック
    if ('effort' in obj) {
      if (typeof obj.effort !== 'string' || !(VALID_EFFORTS as readonly string[]).includes(obj.effort)) {
        errors.push(`${prefix}.effort: "low" | "medium" | "high" のいずれかである必要があります ("${obj.effort}")`);
      }
    }

    // purpose の型チェック
    if ('purpose' in obj && typeof obj.purpose !== 'string') {
      errors.push(`${prefix}.purpose: 文字列ではありません`);
    }

    // detail の型チェック
    if ('detail' in obj && typeof obj.detail !== 'string') {
      errors.push(`${prefix}.detail: 文字列ではありません`);
    }

    // criteria の型チェック
    if ('criteria' in obj) {
      if (!Array.isArray(obj.criteria)) {
        errors.push(`${prefix}.criteria: 配列ではありません`);
      } else if (obj.criteria.some((c: unknown) => typeof c !== 'string')) {
        errors.push(`${prefix}.criteria: すべての要素が文字列である必要があります`);
      }
    }
  });

  if (errors.length > 0) {
    throw new Error(`タスク分解のバリデーションエラー:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return data as TaskDraft[];
}

function buildDecompositionPrompt(story: StoryFile, retryReason?: string): string {
  const retrySection = retryReason
    ? `\n## 前回の却下理由\n\n${retryReason}\n\n上記を踏まえて再度タスク分解してください。\n`
    : '';

  return `あなたはソフトウェア開発のタスク設計の専門家です。以下のストーリーをPR単位のタスクに分解してください。

## ストーリー
${story.content}

## 分解ルール

- 1タスク = 1PR（独立してマージできる単位）
- タスク数は3〜6個
- スラッグは kebab-case（英小文字・ハイフン区切り）
- スラッグは必ず "${story.slug}-" で始める
- 依存関係がある場合は順序を考慮すること
${retrySection}
## 出力形式

以下のJSON配列のみを出力してください。説明文は不要です。

\`\`\`json
[
  {
    "slug": "${story.slug}-01-example",
    "title": "タスクタイトル（日本語）",
    "priority": "high",
    "effort": "low",
    "purpose": "このタスクで何を達成するか（1〜2文）",
    "detail": "実装方針・手順など（具体的に）",
    "criteria": [
      "完了条件1",
      "完了条件2"
    ]
  }
]
\`\`\`

priority は "high" | "medium" | "low"、effort は "low" | "medium" | "high" のいずれかを使用してください。`;
}

/** モジュールレベルのデフォルトバックエンド（テスト時に差し替え可能） */
let defaultBackend: AgentBackend | undefined;

/** テスト用: デフォルトバックエンドを設定する */
export function setDefaultBackend(backend: AgentBackend | undefined): void {
  defaultBackend = backend;
}

export async function decomposeTasks(story: StoryFile, retryReason?: string, backend?: AgentBackend): Promise<TaskDraft[]> {
  const prompt = buildDecompositionPrompt(story, retryReason);
  const agent = backend ?? defaultBackend ?? new ClaudeBackend();
  const fullText = await agent.run(prompt, {
    allowedTools: [],
    permissionMode: 'bypassPermissions',
  });

  // コードブロックを除去してJSONを抽出
  const jsonMatch = fullText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = jsonMatch ? jsonMatch[1].trim() : fullText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`タスク分解のJSONパースに失敗しました: ${e}\n\n出力:\n${fullText}`);
  }

  return validateTaskDrafts(parsed, story.slug);
}
