/**
 * レビューエージェントのワーカースクリプト
 *
 * 別プロセスとして起動され、stdin から JSON メッセージを受け取り、
 * Claude エージェントを実行してレビュー結果を stdout に JSON で返す。
 *
 * 入力 JSON: { diff: string, taskDescription?: string }
 * 出力 JSON: ReviewResult
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildReviewPrompt } from './prompt';
import { ReviewResult } from './types';

interface WorkerInput {
  diff: string;
  taskDescription?: string;
}

function parseReviewResult(text: string): ReviewResult {
  // エージェントの出力から JSON を抽出
  // コードフェンスで囲まれている場合も考慮
  let jsonStr = text.trim();

  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);

  // バリデーション
  if (parsed.verdict !== 'OK' && parsed.verdict !== 'NG') {
    throw new Error(`Invalid verdict: ${parsed.verdict}`);
  }
  if (typeof parsed.summary !== 'string') {
    throw new Error('Missing or invalid summary');
  }
  if (!Array.isArray(parsed.findings)) {
    throw new Error('Missing or invalid findings');
  }

  for (const f of parsed.findings) {
    if (!['error', 'warning', 'info'].includes(f.severity)) {
      throw new Error(`Invalid severity: ${f.severity}`);
    }
    if (typeof f.message !== 'string') {
      throw new Error('Finding missing message');
    }
  }

  return {
    verdict: parsed.verdict,
    summary: parsed.summary,
    findings: parsed.findings.map((f: Record<string, unknown>) => ({
      ...(f.file != null ? { file: String(f.file) } : {}),
      ...(f.line != null ? { line: Number(f.line) } : {}),
      severity: f.severity as 'error' | 'warning' | 'info',
      message: String(f.message),
    })),
  };
}

async function main(): Promise<void> {
  // stdin から入力を読み取り
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const rawInput = Buffer.concat(chunks).toString('utf-8');

  let input: WorkerInput;
  try {
    input = JSON.parse(rawInput);
  } catch {
    const error = { error: 'Invalid input JSON' };
    process.stdout.write(JSON.stringify(error));
    process.exit(1);
  }

  if (!input.diff || typeof input.diff !== 'string') {
    const error = { error: 'Missing or invalid diff field' };
    process.stdout.write(JSON.stringify(error));
    process.exit(1);
  }

  const prompt = buildReviewPrompt({
    diff: input.diff,
    taskDescription: input.taskDescription,
  });

  let agentOutput = '';

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: [],
        permissionMode: 'bypassPermissions',
      },
    })) {
      if (message.type === 'assistant') {
        const content = message.message?.content ?? [];
        for (const block of content) {
          if ('text' in block && block.text) {
            agentOutput += block.text;
          }
        }
      }
    }
  } catch (err) {
    const error = {
      error: `Agent execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    process.stdout.write(JSON.stringify(error));
    process.exit(1);
  }

  try {
    const result = parseReviewResult(agentOutput);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    const error = {
      error: `Failed to parse review result: ${err instanceof Error ? err.message : String(err)}`,
      rawOutput: agentOutput,
    };
    process.stdout.write(JSON.stringify(error));
    process.exit(1);
  }
}

main().catch((err) => {
  const error = { error: `Worker crashed: ${err instanceof Error ? err.message : String(err)}` };
  process.stdout.write(JSON.stringify(error));
  process.exit(1);
});

export { parseReviewResult };
