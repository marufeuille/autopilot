// デバッグスクリプト: Vault パスとファイル検知を確認
// 実行: node debug.mjs
import * as fs from 'fs';
import * as path from 'path';
import { readFileSync } from 'fs';
import { glob } from 'glob';

// .env を手動で読む
const envPath = new URL('.env', import.meta.url).pathname;
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  }
}

const VAULT_PATH = env.VAULT_PATH;
const WATCH_PROJECTS = (env.WATCH_PROJECTS ?? 'claude-workflow-kit').split(',').map(p => p.trim());

console.log('=== Vault Debug ===');
console.log('VAULT_PATH:', VAULT_PATH);
console.log('WATCH_PROJECTS:', WATCH_PROJECTS);

if (!VAULT_PATH) {
  console.error('❌ VAULT_PATH が未設定です');
  process.exit(1);
}

if (!fs.existsSync(VAULT_PATH)) {
  console.error('❌ VAULT_PATH が存在しません:', VAULT_PATH);
  process.exit(1);
}
console.log('✅ VAULT_PATH 存在確認 OK');

for (const project of WATCH_PROJECTS) {
  const tasksDir = path.join(VAULT_PATH, 'Projects', project, 'tasks');
  console.log(`\n--- project: ${project} ---`);
  console.log('tasks dir:', tasksDir);
  console.log('tasks dir exists:', fs.existsSync(tasksDir));

  const pattern = path.join(VAULT_PATH, 'Projects', project, 'tasks', '**', '*.md');
  const files = await glob(pattern, { ignore: ['**/README.md'] });
  console.log('found files:', files.length);

  for (const f of files) {
    const raw = readFileSync(f, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    const status = match?.[1].match(/^status:\s*(.+)$/m)?.[1]?.trim();
    const isPending = status === 'pending_approval';
    console.log(` ${isPending ? '🟡' : '⬜'} ${path.basename(f)} | status: "${status}"`);
  }
}
