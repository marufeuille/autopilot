import * as fs from 'fs';
import matter from 'gray-matter';

function writeStatus(filePath: string, status: string): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  parsed.data.status = status;
  fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data), 'utf-8');
}

export function updateTaskStatus(filePath: string, status: string): void {
  writeStatus(filePath, status);
}

export function updateStoryStatus(filePath: string, status: string): void {
  writeStatus(filePath, status);
}

export function updateTaskFrontmatter(
  filePath: string,
  updates: Record<string, unknown>,
): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  Object.assign(parsed.data, updates);
  fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data), 'utf-8');
}
