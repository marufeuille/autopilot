#!/usr/bin/env ts-node
/**
 * レビューエージェントの CLI エントリポイント
 *
 * 使い方:
 *   # git diff をパイプで渡す
 *   git diff HEAD~1 | npx ts-node src/review/cli.ts
 *
 *   # ファイルから渡す
 *   npx ts-node src/review/cli.ts --diff-file /path/to/diff.txt
 *
 *   # タスク説明を追加
 *   git diff HEAD~1 | npx ts-node src/review/cli.ts --task "ログイン機能の実装"
 *
 *   # タイムアウトを設定（秒）
 *   git diff HEAD~1 | npx ts-node src/review/cli.ts --timeout 600
 */
import * as fs from 'fs';
import { SubprocessReviewRunner } from './subprocess-runner';
import { ReviewError, ReviewTimeoutError } from './types';

function parseArgs(argv: string[]): {
  diffFile?: string;
  taskDescription?: string;
  timeoutSec?: number;
} {
  const result: {
    diffFile?: string;
    taskDescription?: string;
    timeoutSec?: number;
  } = {};

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--diff-file' && argv[i + 1]) {
      result.diffFile = argv[++i];
    } else if (argv[i] === '--task' && argv[i + 1]) {
      result.taskDescription = argv[++i];
    } else if (argv[i] === '--timeout' && argv[i + 1]) {
      result.timeoutSec = parseInt(argv[++i], 10);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`Usage: npx ts-node src/review/cli.ts [options]

Options:
  --diff-file <path>   Read diff from file instead of stdin
  --task <description> Task description for review context
  --timeout <seconds>  Timeout in seconds (default: 300)
  --help, -h           Show this help message

Examples:
  git diff HEAD~1 | npx ts-node src/review/cli.ts
  npx ts-node src/review/cli.ts --diff-file changes.diff --task "Add login feature"
`);
      process.exit(0);
    }
  }

  return result;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // diff を取得
  let diff: string;
  if (args.diffFile) {
    diff = fs.readFileSync(args.diffFile, 'utf-8');
  } else {
    diff = await readStdin();
  }

  if (!diff.trim()) {
    console.error('Error: No diff provided. Pipe a diff to stdin or use --diff-file.');
    process.exit(1);
  }

  console.log(`[review-cli] Starting review (${diff.split('\n').length} lines of diff)`);
  if (args.taskDescription) {
    console.log(`[review-cli] Task: ${args.taskDescription}`);
  }

  const runner = new SubprocessReviewRunner({
    timeoutMs: (args.timeoutSec ?? 300) * 1000,
  });

  try {
    const result = await runner.review(diff, args.taskDescription);

    console.log('\n=== Review Result ===');
    console.log(`Verdict: ${result.verdict}`);
    console.log(`Summary: ${result.summary}`);

    if (result.findings.length > 0) {
      console.log(`\nFindings (${result.findings.length}):`);
      for (const finding of result.findings) {
        const location = [finding.file, finding.line].filter(Boolean).join(':');
        const prefix = location ? `[${location}] ` : '';
        console.log(`  [${finding.severity.toUpperCase()}] ${prefix}${finding.message}`);
      }
    } else {
      console.log('\nNo findings.');
    }

    // JSON 出力
    console.log('\n=== JSON Output ===');
    console.log(JSON.stringify(result, null, 2));

    process.exit(result.verdict === 'OK' ? 0 : 1);
  } catch (error) {
    if (error instanceof ReviewTimeoutError) {
      console.error(`\nError: Review timed out after ${error.timeoutMs / 1000} seconds`);
      process.exit(2);
    } else if (error instanceof ReviewError) {
      console.error(`\nError: ${error.message}`);
      process.exit(2);
    } else {
      console.error('\nUnexpected error:', error);
      process.exit(2);
    }
  }
}

main();
