import { query } from '@anthropic-ai/claude-agent-sdk';
import { StoryFile, TaskFile } from './vault/reader';

// --- 型定義 ---

/** 個別の受け入れ条件チェック結果 */
export interface CriterionResult {
  /** 受け入れ条件のテキスト */
  criterion: string;
  /** PASS または FAIL */
  result: 'PASS' | 'FAIL';
  /** 判定理由 */
  reason: string;
}

/** 受け入れ条件チェック全体の結果 */
export interface AcceptanceCheckResult {
  /** 全条件がPASSしたか */
  allPassed: boolean;
  /** チェックがスキップされたか（受け入れ条件セクションがない場合） */
  skipped: boolean;
  /** 各条件の結果（スキップ時は空配列） */
  results: CriterionResult[];
}

// --- PR情報取得の依存インターフェース ---

/** マージ済みPRの情報 */
export interface MergedPRInfo {
  /** PRのタイトル */
  title: string;
  /** PRの差分サマリ */
  diffSummary: string;
}

/** 受け入れ条件チェッカーが使用する外部依存 */
export interface AcceptanceGateDeps {
  /** gh CLI コマンドを実行する */
  execGh: (args: string[], cwd: string) => string;
  /** Claude にプロンプトを送信してテキスト応答を得る */
  queryAI: (prompt: string) => Promise<string>;
}

// --- 受け入れ条件パーサー ---

/**
 * ストーリーファイルのコンテンツから「受け入れ条件」セクションを抽出し、
 * 各条件をパースして返す。
 *
 * 受け入れ条件セクションが存在しない場合は null を返す。
 */
export function parseAcceptanceCriteria(storyContent: string): string[] | null {
  // 「受け入れ条件」セクション（## レベル）を検出
  const sectionRegex = /^##\s*受け入れ条件\s*$/m;
  const match = sectionRegex.exec(storyContent);
  if (!match) return null;

  // セクション開始位置から次の ## セクションまでの範囲を取得
  const afterSection = storyContent.slice(match.index + match[0].length);
  const nextSectionMatch = /^##\s/m.exec(afterSection);
  const sectionBody = nextSectionMatch
    ? afterSection.slice(0, nextSectionMatch.index)
    : afterSection;

  // チェックボックス形式の行を抽出: - [ ] or - [x]
  const criteria: string[] = [];
  const lines = sectionBody.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const checkboxMatch = trimmed.match(/^-\s*\[[\sx]\]\s*(.+)$/);
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1].trim());
    }
  }

  return criteria.length > 0 ? criteria : null;
}

// --- マージ済みPR情報の収集 ---

/**
 * ストーリーに関連するマージ済みPRの情報を収集する。
 * タスクファイルの frontmatter.pr フィールドからPR URLを取得し、
 * gh CLI で差分サマリを取得する。
 */
export function collectMergedPRs(
  tasks: TaskFile[],
  repoPath: string,
  deps: AcceptanceGateDeps,
): MergedPRInfo[] {
  const prInfos: MergedPRInfo[] = [];

  for (const task of tasks) {
    const prUrl = task.frontmatter?.pr;
    if (typeof prUrl !== 'string' || !prUrl) continue;

    try {
      const prJson = deps.execGh(
        ['pr', 'view', prUrl, '--json', 'title,body,additions,deletions,changedFiles'],
        repoPath,
      );
      const prData = JSON.parse(prJson);
      prInfos.push({
        title: prData.title ?? '',
        diffSummary: `+${prData.additions ?? 0} -${prData.deletions ?? 0} (${prData.changedFiles ?? 0} files changed)`,
      });
    } catch {
      // PR情報取得に失敗した場合はスキップ（ログは呼び出し側で処理）
      console.warn(`[acceptance-gate] failed to fetch PR info: ${prUrl}`);
    }
  }

  return prInfos;
}

// --- プロンプト構築 ---

/**
 * Claude に送信する受け入れ条件チェック用プロンプトを構築する。
 */
export function buildAcceptanceCheckPrompt(
  criteria: string[],
  mergedPRs: MergedPRInfo[],
  storyContent: string,
): string {
  const criteriaList = criteria
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');

  const prList = mergedPRs.length > 0
    ? mergedPRs
        .map((pr, i) => `PR ${i + 1}: "${pr.title}" (${pr.diffSummary})`)
        .join('\n')
    : '（マージ済みPRなし）';

  return `あなたはソフトウェアプロジェクトの受け入れ条件チェッカーです。
以下のストーリーの受け入れ条件を、マージ済みPRの情報と照合して、各条件のPASS/FAILを判定してください。

## ストーリー内容
${storyContent}

## 受け入れ条件
${criteriaList}

## マージ済みPR一覧
${prList}

## 判定ルール
- 各条件について、マージ済みPRの内容やストーリーの実装状況から PASS / FAIL を判定してください
- PRが存在しない場合や判断材料が不十分な場合は、FAILとして理由を述べてください
- 判定は保守的に行ってください（明確に達成が確認できる場合のみPASS）

## 出力形式

以下のJSON配列のみを出力してください。説明文は不要です。

\`\`\`json
[
  {
    "criterion": "受け入れ条件のテキスト",
    "result": "PASS",
    "reason": "判定理由"
  }
]
\`\`\`

result は "PASS" または "FAIL" のいずれかを使用してください。`;
}

// --- Claude 応答パーサー ---

/**
 * Claude の応答テキストから CriterionResult 配列をパースする。
 */
export function parseAIResponse(responseText: string): CriterionResult[] {
  // コードブロックを除去してJSONを抽出
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = jsonMatch ? jsonMatch[1].trim() : responseText.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`受け入れ条件チェック結果のJSONパースに失敗しました:\n${responseText}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('受け入れ条件チェック結果が配列ではありません');
  }

  return parsed.map((item: unknown, index: number) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`results[${index}]: オブジェクトではありません`);
    }
    const obj = item as Record<string, unknown>;

    if (typeof obj.criterion !== 'string') {
      throw new Error(`results[${index}].criterion: 文字列ではありません`);
    }
    if (obj.result !== 'PASS' && obj.result !== 'FAIL') {
      throw new Error(`results[${index}].result: "PASS" または "FAIL" である必要があります ("${obj.result}")`);
    }
    if (typeof obj.reason !== 'string') {
      throw new Error(`results[${index}].reason: 文字列ではありません`);
    }

    return {
      criterion: obj.criterion,
      result: obj.result,
      reason: obj.reason,
    };
  });
}

// --- デフォルト AI クエリ実装 ---

/**
 * Claude Agent SDK を使用してプロンプトを送信し、テキスト応答を返すデフォルト実装。
 */
export async function defaultQueryAI(prompt: string): Promise<string> {
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

  return fullText;
}

// --- メイン関数 ---

/**
 * ストーリーの受け入れ条件をチェックする。
 *
 * 1. ストーリーファイルから「受け入れ条件」セクションをパースする
 * 2. 受け入れ条件セクションがない場合はスキップ（allPassed=true, skipped=true）
 * 3. マージ済みPRの情報を収集する
 * 4. Claude にプロンプトを送信して各条件の PASS/FAIL を判定する
 * 5. 結果を AcceptanceCheckResult として返す
 */
export async function checkAcceptanceCriteria(
  story: StoryFile,
  tasks: TaskFile[],
  repoPath: string,
  deps: AcceptanceGateDeps,
): Promise<AcceptanceCheckResult> {
  // 1. 受け入れ条件をパース
  const criteria = parseAcceptanceCriteria(story.content);

  // 2. 受け入れ条件がない場合はスキップ
  if (!criteria) {
    console.warn(`[acceptance-gate] 受け入れ条件セクションが見つかりません: ${story.slug}`);
    return {
      allPassed: true,
      skipped: true,
      results: [],
    };
  }

  // 3. マージ済みPR情報を収集
  const mergedPRs = collectMergedPRs(tasks, repoPath, deps);

  // 4. プロンプトを構築してClaude に送信
  const prompt = buildAcceptanceCheckPrompt(criteria, mergedPRs, story.content);
  const responseText = await deps.queryAI(prompt);

  // 5. 応答をパースして結果を構築
  const results = parseAIResponse(responseText);
  const allPassed = results.every((r) => r.result === 'PASS');

  return {
    allPassed,
    skipped: false,
    results,
  };
}
