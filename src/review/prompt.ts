/**
 * レビューエージェントに渡すプロンプトテンプレート
 */

export interface ReviewPromptParams {
  /** git diff の内容 */
  diff: string;
  /** タスクの説明（任意） */
  taskDescription?: string;
}

/**
 * レビュープロンプトを生成する
 */
export function buildReviewPrompt(params: ReviewPromptParams): string {
  const taskSection = params.taskDescription
    ? `\n## タスクの説明\n${params.taskDescription}\n`
    : '';

  return `あなたはシニアソフトウェアエンジニアとしてコードレビューを行います。
以下の差分（diff）をレビューし、結果を **必ず JSON のみ** で返してください。
JSON 以外のテキストは一切出力しないでください。
${taskSection}
## レビュー観点

1. **正確性**: ロジックにバグや意図しない挙動がないか
2. **セキュリティ**: 機密情報の漏洩、インジェクション等のリスクがないか
3. **エラーハンドリング**: 例外やエッジケースが適切に処理されているか
4. **型安全性**: TypeScript の型定義が適切か、any の濫用がないか
5. **テスト**: テストが十分に書かれているか、カバレッジに穴がないか
6. **コード品質**: 命名・構造・重複・可読性に問題がないか

## 差分

\`\`\`diff
${params.diff}
\`\`\`

## 出力形式

以下の JSON スキーマに厳密に従って出力してください。

\`\`\`json
{
  "verdict": "OK" | "NG",
  "summary": "レビューの要約（1〜3文）",
  "findings": [
    {
      "file": "ファイルパス（任意）",
      "line": 行番号（任意、number）,
      "severity": "error" | "warning" | "info",
      "message": "指摘内容"
    }
  ]
}
\`\`\`

- \`verdict\`: severity が "error" または "warning" の指摘が1つでもあれば "NG"、なければ "OK"（"info" のみの場合は "OK"）
- \`findings\` が空配列でも構いません（問題がない場合）
- JSON のみを出力し、マークダウンのコードフェンスで囲まないでください
`;
}
