import { query } from '@anthropic-ai/claude-agent-sdk';
import { StoryFile } from './vault/reader';
import { TaskDraft } from './vault/writer';

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

export async function decomposeTasks(story: StoryFile, retryReason?: string): Promise<TaskDraft[]> {
  const prompt = buildDecompositionPrompt(story, retryReason);
  let fullText = '';

  for await (const message of query({
    prompt,
    options: {
      allowedTools: [],
      permissionMode: 'bypassPermissions',
    },
  })) {
    if (message.type === 'assistant') {
      const content = message.message?.content ?? [];
      for (const block of content) {
        if ('text' in block && block.text) {
          fullText += block.text;
        }
      }
    }
  }

  // コードブロックを除去してJSONを抽出
  const jsonMatch = fullText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = jsonMatch ? jsonMatch[1].trim() : fullText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`タスク分解のJSONパースに失敗しました: ${e}\n\n出力:\n${fullText}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`タスク分解の出力が配列ではありません:\n${fullText}`);
  }

  return parsed as TaskDraft[];
}
