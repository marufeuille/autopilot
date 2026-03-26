import { vi } from 'vitest';
import { RunnerDeps } from '../../runner-deps';
import { TaskDraft } from '../../vault/writer';
import { StoryFile, TaskFile, TaskStatus } from '../../vault/reader';
import { ReviewLoopResult } from '../../review/loop';
import { CIPollingResult } from '../../ci/types';

/**
 * createFakeDeps のオーバーライドオプション。
 * 各プロパティは RunnerDeps の対応するメソッドを上書きする。
 */
export type FakeDepsOverrides = Partial<RunnerDeps>;

/**
 * デフォルトのレビューループ成功結果
 */
export function defaultReviewLoopResult(): ReviewLoopResult {
  return {
    finalVerdict: 'OK',
    escalationRequired: false,
    iterations: [
      {
        iteration: 1,
        reviewResult: {
          verdict: 'OK',
          summary: 'All checks passed',
          findings: [],
        },
        timestamp: new Date(),
      },
    ],
    lastReviewResult: {
      verdict: 'OK',
      summary: 'All checks passed',
      findings: [],
    },
    warnings: [],
  };
}

/**
 * デフォルトの CI ポーリング成功結果
 */
export function defaultCIPollingResult(): CIPollingResult {
  return {
    finalStatus: 'success',
    attempts: 1,
    attemptResults: [
      {
        attempt: 1,
        ciResult: {
          status: 'success',
          summary: 'All CI checks passed',
        },
        timestamp: new Date(),
      },
    ],
    lastCIResult: {
      status: 'success',
      summary: 'All CI checks passed',
    },
  };
}

/**
 * RunnerDeps のフェイク実装を返す。
 *
 * すべてのメソッドは vi.fn() でラップされ、呼び出し回数・引数を検証可能。
 * デフォルト動作:
 * - runAgent: 成功（何もしない）
 * - execGh: pr view --json ではマージ可能な状態の JSON、pr merge では空文字、その他は PR URL を返す
 * - execCommand: 空文字列を返す
 * - runReviewLoop: verdict OK を返す
 * - runCIPollingLoop: success を返す
 * - decomposeTasks: 空配列を返す
 * - createTaskFile: 何もしない
 * - syncMainBranch: 成功（何もしない）
 * - getStoryTasks: 空配列を返す
 * - updateFileStatus: 何もしない
 */
export function createFakeDeps(overrides?: FakeDepsOverrides): RunnerDeps {
  const defaults: RunnerDeps = {
    runAgent: vi.fn().mockResolvedValue(undefined),
    execGh: vi.fn().mockImplementation((args: string[]) => {
      // pr view --json の場合はマージ可能な状態の JSON を返す
      if (args.includes('view') && args.includes('--json')) {
        return JSON.stringify({
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [
            { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        });
      }
      // pr merge の場合は空文字を返す（成功）
      if (args.includes('merge')) {
        return '';
      }
      // その他は PR URL を返す
      return 'https://github.com/test/repo/pull/1';
    }),
    execCommand: vi.fn().mockReturnValue(''),
    runReviewLoop: vi.fn().mockResolvedValue(defaultReviewLoopResult()),
    runCIPollingLoop: vi.fn().mockResolvedValue(defaultCIPollingResult()),
    decomposeTasks: vi.fn().mockResolvedValue([]),
    createTaskFile: vi.fn(),
    syncMainBranch: vi.fn().mockResolvedValue(undefined),
    getStoryTasks: vi.fn().mockResolvedValue([]),
    updateFileStatus: vi.fn(),
    recordTaskCompletion: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    checkAcceptanceCriteria: vi.fn().mockResolvedValue({
      allPassed: true,
      skipped: false,
      results: [],
    }),
    generateAdditionalTasks: vi.fn().mockResolvedValue([]),
  };

  // overrides を適用（vi.fn() でラップ済みの場合はそのまま使う）
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        (defaults as Record<string, unknown>)[key] = value;
      }
    }
  }

  return defaults;
}
