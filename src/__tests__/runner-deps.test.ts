import { describe, it, expect, vi, beforeEach } from 'vitest';

// AgentBackend モジュールをモック
vi.mock('../agent/backend', () => {
  const mockRun = vi.fn().mockResolvedValue('mock output');
  return {
    createBackend: vi.fn().mockReturnValue({ run: mockRun }),
  };
});

// config をモック
vi.mock('../config', () => ({
  config: {
    agentBackends: {
      implementation: { type: 'claude' },
      review: { type: 'claude' },
      planning: { type: 'claude' },
      fix: { type: 'claude' },
    },
  },
}));

// 外部依存をモック
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../vault/reader', () => ({ getStoryTasks: vi.fn() }));
vi.mock('../vault/writer', () => ({
  updateFileStatus: vi.fn(),
  createTaskFile: vi.fn(),
  recordTaskCompletion: vi.fn(),
}));
vi.mock('../decomposer', () => ({ decomposeTasks: vi.fn() }));
vi.mock('../git', () => ({
  syncMainBranch: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('../review', () => ({ runReviewLoop: vi.fn() }));
vi.mock('../ci', () => ({ runCIPollingLoop: vi.fn() }));
vi.mock('../story-acceptance-gate', () => ({
  checkAcceptanceCriteria: vi.fn(),
  generateAdditionalTasks: vi.fn(),
  defaultQueryAI: vi.fn(),
}));
vi.mock('../logger', () => ({
  createCommandLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createDefaultRunnerDeps } from '../runner-deps';
import { createBackend } from '../agent/backend';

describe('createDefaultRunnerDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('config.agentBackends.implementation に基づいて createBackend を呼ぶ', () => {
    createDefaultRunnerDeps();
    expect(createBackend).toHaveBeenCalledWith({ type: 'claude' });
  });

  it('runAgent は AgentBackend.run() を経由して動作する', async () => {
    const deps = createDefaultRunnerDeps();
    await deps.runAgent('test prompt', '/workspace');

    const mockBackend = (createBackend as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(mockBackend.run).toHaveBeenCalledWith('test prompt', {
      cwd: '/workspace',
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
    });
  });

  it('runAgent は AgentBackend.run() のエラーをそのまま伝播する', async () => {
    const mockRun = vi.fn().mockRejectedValue(new Error('backend error'));
    (createBackend as ReturnType<typeof vi.fn>).mockReturnValue({ run: mockRun });

    const deps = createDefaultRunnerDeps();
    await expect(deps.runAgent('test', '/workspace')).rejects.toThrow('backend error');
  });

  describe('テスト時のモックバックエンド差し替え', () => {
    it('runAgent をモック関数で差し替えてテストできる', async () => {
      const deps = createDefaultRunnerDeps();
      const mockRunAgent = vi.fn().mockResolvedValue(undefined);
      deps.runAgent = mockRunAgent;

      await deps.runAgent('prompt', '/cwd');
      expect(mockRunAgent).toHaveBeenCalledWith('prompt', '/cwd');
    });
  });
});
