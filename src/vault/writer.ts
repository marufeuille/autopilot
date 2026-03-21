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
  const content = `\n# ${draft.title}\n\n## 目的\n\n${draft.purpose}\n\n## 詳細\n\n${draft.detail}\n\n## 完了条件\n\n${criteriaList}\n\n## メモ\n\n`;

  fs.writeFileSync(filePath, matter.stringify(content, frontmatter));
  return filePath;
}
