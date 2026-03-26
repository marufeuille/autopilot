import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { vaultTasksPath } from '../config';

export function updateFileStatus(filePath: string, status: string): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  parsed.data.status = status;
  fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
}

/**
 * タスク完了時の Vault レコード記録オプション。
 *
 * mode フィールドは optional（後方互換性のため）。
 */
export interface TaskCompletionRecord {
  /** 完了モード。'local-only' はリモートなし環境、'normal' は通常フロー */
  mode?: 'local-only' | 'normal';
  /** PR の URL。ローカルオンリー時は null */
  prUrl: string | null;
  /** ローカルコミットの SHA（ローカルオンリー時） */
  localCommitSha?: string | null;
}

/**
 * タスク完了をVaultに記録する。
 *
 * frontmatter に mode, pr, commit_sha, finished_at を書き込む。
 * 既存フィールドとの後方互換性を保つため、mode は optional。
 */
export function recordTaskCompletion(filePath: string, record: TaskCompletionRecord): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);

  // gray-matter はパース結果をキャッシュするため、data を直接変更すると
  // 同一内容のファイルに対する後続のパースに影響する。
  // shallow copy して安全に変更する。
  const data = { ...parsed.data };

  data.status = 'Done';
  data.finished_at = new Date().toISOString().slice(0, 10);
  data.pr = record.prUrl ?? null;

  if (record.mode) {
    data.mode = record.mode;
  }

  if (record.localCommitSha) {
    data.commit_sha = record.localCommitSha;
  }

  fs.writeFileSync(filePath, matter.stringify(parsed.content, data));
}

export interface TaskDraft {
  slug: string;
  title: string;
  priority: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  purpose: string;
  detail: string;
  criteria: string[];
}

export function createTaskFile(project: string, storySlug: string, draft: TaskDraft): string {
  const dir = vaultTasksPath(project, storySlug);
  const filePath = path.join(dir, `${draft.slug}.md`);

  if (fs.existsSync(filePath)) {
    throw new Error(`Task file already exists: ${filePath}`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = {
    status: 'Todo',
    priority: draft.priority,
    effort: draft.effort,
    story: storySlug,
    due: null,
    project,
    created: today,
    finished_at: null,
    pr: null,
  };

  const criteriaList = draft.criteria.map((c) => `- [ ] ${c}`).join('\n');
  const content = `\n# ${draft.title}\n\n## 目的\n\n${draft.purpose}\n\n## 詳細\n\n${draft.detail}\n\n## 完了条件\n\n${criteriaList}\n\n## テスト方針\n\n<!-- タスクごとのテスト方針を記述してください（例: 単体テストのみ、統合テストのみ、モック方針など）。未記入の場合はデフォルトのテストルールが適用されます。 -->\n\n## メモ\n\n`;

  fs.writeFileSync(filePath, matter.stringify(content, frontmatter));
  return filePath;
}
