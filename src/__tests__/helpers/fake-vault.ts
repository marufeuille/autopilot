import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';
import { TaskStatus } from '../../vault/reader';

/**
 * ストーリーの定義
 */
export interface FakeStoryOptions {
  slug: string;
  status?: string;
  title?: string;
  content?: string;
  frontmatter?: Record<string, unknown>;
}

/**
 * タスクの定義
 */
export interface FakeTaskOptions {
  slug: string;
  status?: TaskStatus;
  priority?: 'high' | 'medium' | 'low';
  effort?: 'low' | 'medium' | 'high';
  title?: string;
  content?: string;
  frontmatter?: Record<string, unknown>;
}

/**
 * createFakeVault のオプション
 */
export interface FakeVaultOptions {
  project: string;
  story: FakeStoryOptions;
  tasks?: FakeTaskOptions[];
}

/**
 * createFakeVault の返り値
 */
export interface FakeVaultResult {
  /** Vault ルートパス（tmpdir 配下） */
  vaultPath: string;
  /** プロジェクトパス */
  projectPath: string;
  /** ストーリーファイルパス */
  storyFilePath: string;
  /** タスクディレクトリパス */
  tasksDir: string;
  /** 各タスクファイルパスの配列 */
  taskFilePaths: string[];
  /** 一時ディレクトリを削除するクリーンアップ関数 */
  cleanup: () => void;
}

/**
 * 一時ディレクトリに擬似 Vault を構築する。
 *
 * `Projects/{project}/stories/` にストーリー .md を、
 * `Projects/{project}/tasks/{storySlug}/` にタスク .md を生成する。
 */
export function createFakeVault(options: FakeVaultOptions): FakeVaultResult {
  const { project, story, tasks = [] } = options;

  // 一時ディレクトリを作成
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-test-vault-'));

  // ディレクトリ構造を作成
  const projectPath = path.join(vaultPath, 'Projects', project);
  const storiesDir = path.join(projectPath, 'stories');
  const tasksDir = path.join(projectPath, 'tasks', story.slug);

  fs.mkdirSync(storiesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  // ストーリーファイルを生成
  const storyFrontmatter = {
    status: story.status ?? 'Doing',
    priority: 'medium',
    effort: 'medium',
    project,
    created: '2026-01-01',
    ...story.frontmatter,
  };

  const storyContent =
    story.content ??
    `\n# ${story.title ?? story.slug}\n\n## 価値・ゴール\n\nテスト用ストーリー\n\n## 受け入れ条件\n\n- [ ] テスト条件\n\n## タスク\n\n${tasks.map((t) => `- [ ] [[tasks/${story.slug}/${t.slug}]]`).join('\n')}\n\n## メモ\n\n`;

  const storyFilePath = path.join(storiesDir, `${story.slug}.md`);
  fs.writeFileSync(storyFilePath, matter.stringify(storyContent, storyFrontmatter));

  // タスクファイルを生成
  const taskFilePaths: string[] = [];
  for (const task of tasks) {
    const taskFrontmatter = {
      status: task.status ?? 'Todo',
      priority: task.priority ?? 'medium',
      effort: task.effort ?? 'medium',
      story: story.slug,
      due: null,
      project,
      created: '2026-01-01',
      finished_at: null,
      pr: null,
      ...task.frontmatter,
    };

    const taskContent =
      task.content ??
      `\n# ${task.title ?? task.slug}\n\n## 目的\n\nテスト用タスク\n\n## 詳細\n\nテスト詳細\n\n## 完了条件\n\n- [ ] テスト完了条件\n\n## メモ\n\n`;

    const taskFilePath = path.join(tasksDir, `${task.slug}.md`);
    fs.writeFileSync(taskFilePath, matter.stringify(taskContent, taskFrontmatter));
    taskFilePaths.push(taskFilePath);
  }

  const cleanup = () => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  };

  return {
    vaultPath,
    projectPath,
    storyFilePath,
    tasksDir,
    taskFilePaths,
    cleanup,
  };
}
