import * as fs from 'fs';
import matter from 'gray-matter';

export function updateTaskStatus(filePath: string, status: string): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);

  parsed.data.status = status;

  const updated = matter.stringify(parsed.content, parsed.data);
  fs.writeFileSync(filePath, updated, 'utf-8');
}

export function updateTaskFrontmatter(
  filePath: string,
  updates: Record<string, unknown>,
): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);

  Object.assign(parsed.data, updates);

  const updated = matter.stringify(parsed.content, parsed.data);
  fs.writeFileSync(filePath, updated, 'utf-8');
}
