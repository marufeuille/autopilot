import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { ReviewResult, ReviewError, ReviewTimeoutError, determineVerdict } from './types';

/**
 * サブプロセスレビューランナーの設定
 */
export interface SubprocessRunnerOptions {
  /** タイムアウト（ミリ秒）。デフォルト: 5分 */
  timeoutMs?: number;
  /** ts-node の実行パス。デフォルト: node_modules/.bin/ts-node */
  tsNodePath?: string;
  /** ワーカースクリプトのパス。デフォルト: 自動解決 */
  workerPath?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5分

/**
 * レビューエージェントをサブプロセスとして起動・管理するクラス
 *
 * 実装エージェントとは独立したプロセスで Claude Code エージェントを起動し、
 * diff を入力として渡してレビュー結果を構造化 JSON で受け取る。
 */
export class SubprocessReviewRunner {
  private readonly timeoutMs: number;
  private readonly tsNodePath: string;
  private readonly workerPath: string;

  constructor(options: SubprocessRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const projectRoot = path.resolve(__dirname, '../..');
    this.tsNodePath =
      options.tsNodePath ?? path.join(projectRoot, 'node_modules', '.bin', 'ts-node');
    this.workerPath =
      options.workerPath ?? path.resolve(__dirname, 'worker.ts');
  }

  /**
   * diff をレビューして結果を返す
   */
  async review(diff: string, taskDescription?: string): Promise<ReviewResult> {
    if (!diff || typeof diff !== 'string') {
      throw new ReviewError('diff must be a non-empty string');
    }

    const input = JSON.stringify({ diff, taskDescription });

    return new Promise<ReviewResult>((resolve, reject) => {
      let child: ChildProcess;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        child = spawn(this.tsNodePath, [this.workerPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (err) {
        reject(
          new ReviewError(
            `Failed to spawn worker process: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err : undefined,
          ),
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      // タイムアウト制御
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // 猶予期間後に強制終了
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, this.timeoutMs);

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(
          new ReviewError(
            `Worker process error: ${err.message}`,
            err,
          ),
        );
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);

        if (timedOut) {
          reject(new ReviewTimeoutError(this.timeoutMs));
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (code !== 0) {
          // ワーカーがエラー JSON を返しているか確認
          let errorMessage = `Worker process exited with code ${code}`;
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.error) {
              errorMessage = parsed.error;
            }
          } catch {
            // stdout がパースできない場合は stderr を使う
            if (stderr) {
              errorMessage += `: ${stderr.slice(0, 500)}`;
            }
          }
          reject(new ReviewError(errorMessage));
          return;
        }

        // 正常終了: stdout から結果をパース
        try {
          const result: ReviewResult = JSON.parse(stdout);
          // 最低限のバリデーション
          if (result.verdict !== 'OK' && result.verdict !== 'NG') {
            reject(new ReviewError(`Invalid verdict in result: ${result.verdict}`));
            return;
          }
          // findings に基づいて verdict を再判定（LLM の判定ミスを防止）
          result.verdict = determineVerdict(result.findings ?? []);
          resolve(result);
        } catch (err) {
          reject(
            new ReviewError(
              `Failed to parse worker output: ${stdout.slice(0, 500)}`,
              err instanceof Error ? err : undefined,
            ),
          );
        }
      });

      // 入力を stdin に書き込み
      child.stdin?.write(input);
      child.stdin?.end();
    });
  }
}
