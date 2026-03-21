import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { config } from '../config';

export interface TaskFile {
  filePath: string;
  project: string;
  slug: string;
  status: string;
  story: string;
  priority: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export async function getPendingApprovalTasks(project: string): Promise<TaskFile[]> {
  const pattern = path.join(config.vaultPath, 'Projects', project, 'tasks', '**', '*.md');
  const files = await glob(pattern, { ignore: ['**/README.md'] });

  const tasks: TaskFile[] = [];
  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);

    if (data.status === 'pending_approval') {
      tasks.push({
        filePath,
        project,
        slug: path.basename(filePath, '.md'),
        status: data.status,
        story: data.story ?? '',
        priority: data.priority ?? 'medium',
        frontmatter: data,
        content,
      });
    }
  }

  return tasks;
}

export function readTaskFile(filePath: string): TaskFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const slug = path.basename(filePath, '.md');

  // derive project from path: .../Projects/<project>/tasks/...
  const parts = filePath.split(path.sep);
  const projectsIdx = parts.lastIndexOf('Projects');
  const project = projectsIdx >= 0 ? parts[projectsIdx + 1] : '';

  return {
    filePath,
    project,
    slug,
    status: data.status ?? '',
    story: data.story ?? '',
    priority: data.priority ?? 'medium',
    frontmatter: data,
    content,
  };
}
