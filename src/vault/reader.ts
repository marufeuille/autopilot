import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { config, vaultProjectPath, vaultStoriesPath, vaultTasksPath } from '../config';

/** slug として許可する文字パターン（英数字・ハイフン・アンダースコアのみ） */
const VALID_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type TaskStatus = 'Todo' | 'Doing' | 'Done' | 'Failed' | 'Skipped' | 'Cancelled';
export type StoryStatus = 'Draft' | 'Todo' | 'Queued' | 'Doing' | 'Done' | 'Failed' | 'Cancelled';

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>(['Todo', 'Doing', 'Done', 'Failed', 'Skipped', 'Cancelled']);
const VALID_STORY_STATUSES: ReadonlySet<string> = new Set<StoryStatus>(['Draft', 'Todo', 'Queued', 'Doing', 'Done', 'Failed', 'Cancelled']);

function parseTaskStatus(value: unknown): TaskStatus {
  if (typeof value === 'string' && VALID_TASK_STATUSES.has(value)) return value as TaskStatus;
  return 'Todo';
}

function parseStoryStatus(value: unknown): StoryStatus {
  if (typeof value === 'string' && VALID_STORY_STATUSES.has(value)) return value as StoryStatus;
  return 'Todo';
}

export interface StoryFile {
  filePath: string;
  project: string;
  slug: string;
  status: StoryStatus;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface TaskFile {
  filePath: string;
  project: string;
  storySlug: string;
  slug: string;
  status: TaskStatus;
  frontmatter: Record<string, unknown>;
  content: string;
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
    status: parseStoryStatus(data.status),
    frontmatter: data,
    content,
  };
}

export async function getStoryTasks(project: string, storySlug: string): Promise<TaskFile[]> {
  const pattern = path.join(vaultTasksPath(project, storySlug), '*.md');
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
      status: parseTaskStatus(data.status),
      frontmatter: data,
      content,
    });
  }
  return tasks.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * slug からストーリーファイルを読み込む。
 *
 * 指定されたプロジェクト（未指定時は config.watchProject）の
 * ストーリーディレクトリから `{slug}.md` を検索する。
 * ファイルが存在しない場合はエラーを throw する。
 */
export function readStoryBySlug(storySlug: string, project?: string): StoryFile {
  // パストラバーサル防止: slug に許可されない文字が含まれる場合は拒否
  if (!VALID_SLUG_PATTERN.test(storySlug)) {
    throw new Error(`不正なストーリースラッグです: "${storySlug}"`);
  }

  const resolvedProject = project ?? config.watchProject;
  const filePath = path.join(vaultStoriesPath(resolvedProject), `${storySlug}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Story "${storySlug}" が見つかりません`);
  }
  return readStoryFile(filePath);
}

export function getProjectReadmePath(project: string): string {
  return path.join(vaultProjectPath(project), 'README.md');
}
