import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { config } from '../config';

export interface StoryFile {
  filePath: string;
  project: string;
  slug: string;
  status: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface TaskFile {
  filePath: string;
  project: string;
  storySlug: string;
  slug: string;
  status: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

// Stories

export async function getDoingStories(project: string): Promise<StoryFile[]> {
  const pattern = path.join(config.vaultPath, 'Projects', project, 'stories', '*.md');
  const files = await glob(pattern);
  const stories: StoryFile[] = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    if (data.status === 'Doing') {
      stories.push({
        filePath,
        project,
        slug: path.basename(filePath, '.md'),
        status: data.status,
        frontmatter: data,
        content,
      });
    }
  }
  return stories;
}

export function readStoryFile(filePath: string): StoryFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const parts = filePath.split(path.sep);
  const projectsIdx = parts.lastIndexOf('Projects');
  const project = projectsIdx >= 0 ? parts[projectsIdx + 1] : '';
  return {
    filePath,
    project,
    slug: path.basename(filePath, '.md'),
    status: data.status ?? '',
    frontmatter: data,
    content,
  };
}

// Tasks

export async function getStoryTasks(project: string, storySlug: string): Promise<TaskFile[]> {
  const pattern = path.join(
    config.vaultPath, 'Projects', project, 'tasks', storySlug, '*.md',
  );
  const files = await glob(pattern);
  const tasks: TaskFile[] = [];

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    tasks.push({
      filePath,
      project,
      storySlug,
      slug: path.basename(filePath, '.md'),
      status: data.status ?? 'Todo',
      frontmatter: data,
      content,
    });
  }
  // ファイル名でソート（01-xx, 02-xx など）
  return tasks.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readTaskFile(filePath: string): TaskFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const parts = filePath.split(path.sep);
  const tasksIdx = parts.lastIndexOf('tasks');
  const storySlug = tasksIdx >= 0 ? parts[tasksIdx + 1] : '';
  const projectsIdx = parts.lastIndexOf('Projects');
  const project = projectsIdx >= 0 ? parts[projectsIdx + 1] : '';
  return {
    filePath,
    project,
    storySlug,
    slug: path.basename(filePath, '.md'),
    status: data.status ?? 'Todo',
    frontmatter: data,
    content,
  };
}
