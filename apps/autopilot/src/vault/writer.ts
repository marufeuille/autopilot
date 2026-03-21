import * as fs from 'fs';
import matter from 'gray-matter';

export function updateFileStatus(filePath: string, status: string): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  parsed.data.status = status;
  fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data));
}
