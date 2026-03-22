/**
 * ストーリーファイルをVaultに書き出すモジュール
 *
 * Claudeが生成したストーリードラフトをパースし、
 * フロントマター付きのMarkdownファイルとしてVaultのstoriesディレクトリに保存する。
 */
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { vaultStoriesPath } from '../config';

/**
 * ストーリードラフトのパース結果
 */
export interface ParsedStoryDraft {
  title: string;
  value: string;
  acceptance: string;
  tasks: string;
}

/**
 * Claudeが生成したストーリードラフトをパースする
 *
 * ### タイトル / ### 価値・ゴール / ### 受け入れ条件 / ### タスク案
 * の各セクションを抽出する。
 */
export function parseStoryDraft(draft: string): ParsedStoryDraft {
  const sections: Record<string, string> = {};
  let currentKey = '';

  for (const line of draft.split('\n')) {
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      currentKey = headerMatch[1].trim();
      sections[currentKey] = '';
    } else if (currentKey) {
      sections[currentKey] += line + '\n';
    }
  }

  const trim = (key: string) => (sections[key] ?? '').trim();

  return {
    title: trim('タイトル'),
    value: trim('価値・ゴール'),
    acceptance: trim('受け入れ条件'),
    tasks: trim('タスク案'),
  };
}

/**
 * タイトル文字列からスラッグを生成する
 *
 * ASCII文字のみ（ラテン文字含む）の場合はケバブケースに変換する。
 * アクセント付きラテン文字（例: Café）は NFD 正規化で基本文字に分解してから処理する。
 * 日本語など非ラテン文字を含む場合はタイムスタンプベースのスラッグを生成する。
 *
 * 括弧やその他の記号は意図的に除去し、英数字・スペース・ハイフンのみを残す。
 *
 * @param title - ストーリータイトル
 * @param now - 現在日時（テスト時にDI可能、デフォルトは new Date()）
 */
export function generateSlug(title: string, now?: Date): string {
  // NFD正規化でアクセント付き文字を基本文字+結合文字に分解し、
  // 結合文字（ダイアクリティカルマーク）を除去する
  const normalized = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // ASCII英数字・スペース・ハイフンのみ残す（括弧等の記号は意図的に除去）
  const ascii = normalized
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim();

  if (ascii.length > 0) {
    return ascii
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  // 日本語など非ラテン文字のみの場合はタイムスタンプベースのスラッグ
  const timestamp = now ?? new Date();
  const dateStr = timestamp.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = timestamp.toISOString().slice(11, 19).replace(/:/g, '');
  return `story-${dateStr}-${timeStr}`;
}

/**
 * ストーリーMarkdownファイルの内容を構築する
 */
export function buildStoryFileContent(
  parsed: ParsedStoryDraft,
  slug: string,
  project: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = {
    status: 'Todo',
    priority: 'medium',
    effort: 'medium',
    slug,
    project,
    created: today,
  };

  const content = `
# ${parsed.title}

## 価値・ゴール

${parsed.value}

## 受け入れ条件

${parsed.acceptance}

## タスク

${parsed.tasks}

## メモ

`;

  return matter.stringify(content, frontmatter);
}

/**
 * ストーリーファイルをVaultに作成する
 *
 * @param project - プロジェクト名
 * @param parsed - パース済みストーリードラフト
 * @param slug - ストーリーのスラッグ（省略時はタイトルから自動生成）
 * @returns 作成されたファイルの絶対パス
 * @throws ファイル作成に失敗した場合
 */
export function createStoryFile(
  project: string,
  parsed: ParsedStoryDraft,
  slug?: string,
): string {
  const storySlug = slug ?? generateSlug(parsed.title);
  const storiesDir = vaultStoriesPath(project);
  const filePath = path.join(storiesDir, `${storySlug}.md`);

  if (fs.existsSync(filePath)) {
    throw new Error(`Story file already exists: ${filePath}`);
  }

  fs.mkdirSync(storiesDir, { recursive: true });

  const fileContent = buildStoryFileContent(parsed, storySlug, project);
  fs.writeFileSync(filePath, fileContent);

  return filePath;
}
