import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseAcceptanceCriteria,
  collectMergedPRs,
  buildAcceptanceCheckPrompt,
  parseAIResponse,
  checkAcceptanceCriteria,
  AcceptanceGateDeps,
  AcceptanceCheckResult,
  CriterionResult,
} from '../story-acceptance-gate';
import { StoryFile, TaskFile } from '../vault/reader';

// --- ヘルパー ---

function createStoryFile(overrides: Partial<StoryFile> = {}): StoryFile {
  return {
    filePath: '/vault/Projects/test-project/stories/test-story.md',
    project: 'test-project',
    slug: 'test-story',
    status: 'Doing',
    frontmatter: { status: 'Doing' },
    content: `
# テストストーリー

## 価値・ゴール

テスト用のストーリー

## 受け入れ条件

- [ ] ログインAPIが動作する
- [ ] テストが通る
- [ ] ドキュメントが更新されている

## タスク

## メモ
`,
    ...overrides,
  };
}

function createTaskFile(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    filePath: '/vault/Projects/test-project/tasks/test-story/test-story-01.md',
    project: 'test-project',
    storySlug: 'test-story',
    slug: 'test-story-01',
    status: 'Done',
    frontmatter: { status: 'Done', pr: 'https://github.com/test/repo/pull/1' },
    content: '# Task 1',
    ...overrides,
  };
}

function createFakeGateDeps(overrides: Partial<AcceptanceGateDeps> = {}): AcceptanceGateDeps {
  return {
    execGh: vi.fn().mockReturnValue(JSON.stringify({
      title: 'Test PR',
      body: 'Test body',
      additions: 100,
      deletions: 20,
      changedFiles: 5,
    })),
    queryAI: vi.fn().mockResolvedValue('[]'),
    ...overrides,
  };
}

// --- parseAcceptanceCriteria ---

describe('parseAcceptanceCriteria', () => {
  it('受け入れ条件セクションからチェックボックス付き条件を抽出する', () => {
    const content = `
# ストーリー

## 受け入れ条件

- [ ] 条件A
- [ ] 条件B
- [x] 条件C（チェック済み）

## タスク
`;
    const result = parseAcceptanceCriteria(content);
    expect(result).toEqual(['条件A', '条件B', '条件C（チェック済み）']);
  });

  it('受け入れ条件セクションがない場合はnullを返す', () => {
    const content = `
# ストーリー

## 概要

テスト用ストーリー

## タスク
`;
    const result = parseAcceptanceCriteria(content);
    expect(result).toBeNull();
  });

  it('受け入れ条件セクションはあるがチェックボックスがない場合はnullを返す', () => {
    const content = `
# ストーリー

## 受け入れ条件

特に条件なし

## タスク
`;
    const result = parseAcceptanceCriteria(content);
    expect(result).toBeNull();
  });

  it('受け入れ条件がファイル末尾にある場合でもパースできる', () => {
    const content = `
# ストーリー

## 受け入れ条件

- [ ] 最後の条件
`;
    const result = parseAcceptanceCriteria(content);
    expect(result).toEqual(['最後の条件']);
  });

  it('受け入れ条件の前後に空行がある場合でもパースできる', () => {
    const content = `
## 受け入れ条件

- [ ] 条件1

- [ ] 条件2

## メモ
`;
    const result = parseAcceptanceCriteria(content);
    expect(result).toEqual(['条件1', '条件2']);
  });
});

// --- collectMergedPRs ---

describe('collectMergedPRs', () => {
  it('タスクのfrontmatter.prからPR情報を収集する', () => {
    const tasks: TaskFile[] = [
      createTaskFile({ frontmatter: { status: 'Done', pr: 'https://github.com/test/repo/pull/1' } }),
      createTaskFile({
        slug: 'test-story-02',
        frontmatter: { status: 'Done', pr: 'https://github.com/test/repo/pull/2' },
      }),
    ];

    const deps = createFakeGateDeps();
    const result = collectMergedPRs(tasks, '/repo', deps);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      title: 'Test PR',
      diffSummary: '+100 -20 (5 files changed)',
    });
    expect(deps.execGh).toHaveBeenCalledTimes(2);
  });

  it('PRフィールドがないタスクはスキップする', () => {
    const tasks: TaskFile[] = [
      createTaskFile({ frontmatter: { status: 'Done' } }),
      createTaskFile({ frontmatter: { status: 'Done', pr: '' } }),
    ];

    const deps = createFakeGateDeps();
    const result = collectMergedPRs(tasks, '/repo', deps);

    expect(result).toHaveLength(0);
    expect(deps.execGh).not.toHaveBeenCalled();
  });

  it('PR情報取得に失敗した場合はスキップする', () => {
    const tasks: TaskFile[] = [
      createTaskFile({ frontmatter: { status: 'Done', pr: 'https://github.com/test/repo/pull/1' } }),
    ];

    const deps = createFakeGateDeps({
      execGh: vi.fn().mockImplementation(() => { throw new Error('gh failed'); }),
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = collectMergedPRs(tasks, '/repo', deps);

    expect(result).toHaveLength(0);
    consoleSpy.mockRestore();
  });
});

// --- buildAcceptanceCheckPrompt ---

describe('buildAcceptanceCheckPrompt', () => {
  it('条件とPR情報を含むプロンプトを構築する', () => {
    const criteria = ['ログインAPIが動作する', 'テストが通る'];
    const mergedPRs = [{ title: 'Add login API', diffSummary: '+100 -20 (5 files changed)' }];
    const storyContent = '# テストストーリー';

    const prompt = buildAcceptanceCheckPrompt(criteria, mergedPRs, storyContent);

    expect(prompt).toContain('1. ログインAPIが動作する');
    expect(prompt).toContain('2. テストが通る');
    expect(prompt).toContain('Add login API');
    expect(prompt).toContain('+100 -20 (5 files changed)');
    expect(prompt).toContain('# テストストーリー');
  });

  it('PR情報が空の場合は「マージ済みPRなし」と表示する', () => {
    const prompt = buildAcceptanceCheckPrompt(['条件1'], [], 'content');
    expect(prompt).toContain('（マージ済みPRなし）');
  });
});

// --- parseAIResponse ---

describe('parseAIResponse', () => {
  it('正しいJSON応答をパースする', () => {
    const response = `\`\`\`json
[
  {
    "criterion": "ログインAPIが動作する",
    "result": "PASS",
    "reason": "PRでログインAPI実装済み"
  },
  {
    "criterion": "テストが通る",
    "result": "FAIL",
    "reason": "テストPRが見つからない"
  }
]
\`\`\``;

    const results = parseAIResponse(response);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      criterion: 'ログインAPIが動作する',
      result: 'PASS',
      reason: 'PRでログインAPI実装済み',
    });
    expect(results[1]).toEqual({
      criterion: 'テストが通る',
      result: 'FAIL',
      reason: 'テストPRが見つからない',
    });
  });

  it('コードブロックなしのJSON応答もパースできる', () => {
    const response = `[{"criterion": "条件1", "result": "PASS", "reason": "OK"}]`;
    const results = parseAIResponse(response);
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe('PASS');
  });

  it('不正なJSONの場合はエラーをスローする', () => {
    expect(() => parseAIResponse('invalid json')).toThrow('JSONパースに失敗');
  });

  it('配列でない場合はエラーをスローする', () => {
    expect(() => parseAIResponse('{"key": "value"}')).toThrow('配列ではありません');
  });

  it('result が PASS/FAIL 以外の場合はエラーをスローする', () => {
    const response = `[{"criterion": "条件", "result": "MAYBE", "reason": "不明"}]`;
    expect(() => parseAIResponse(response)).toThrow('"PASS" または "FAIL"');
  });

  it('criterion が文字列でない場合はエラーをスローする', () => {
    const response = `[{"criterion": 123, "result": "PASS", "reason": "OK"}]`;
    expect(() => parseAIResponse(response)).toThrow('文字列ではありません');
  });

  it('reason が文字列でない場合はエラーをスローする', () => {
    const response = `[{"criterion": "条件", "result": "PASS", "reason": 123}]`;
    expect(() => parseAIResponse(response)).toThrow('reason: 文字列ではありません');
  });
});

// --- checkAcceptanceCriteria ---

describe('checkAcceptanceCriteria', () => {
  it('全条件PASSの場合、allPassed=trueを返す', async () => {
    const story = createStoryFile();
    const tasks = [createTaskFile()];
    const aiResponse = JSON.stringify([
      { criterion: 'ログインAPIが動作する', result: 'PASS', reason: 'PR#1で実装済み' },
      { criterion: 'テストが通る', result: 'PASS', reason: 'テスト追加済み' },
      { criterion: 'ドキュメントが更新されている', result: 'PASS', reason: 'README更新済み' },
    ]);

    const deps = createFakeGateDeps({
      queryAI: vi.fn().mockResolvedValue(aiResponse),
    });

    const result = await checkAcceptanceCriteria(story, tasks, '/repo', deps);

    expect(result.allPassed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.result === 'PASS')).toBe(true);
  });

  it('一部FAILの場合、allPassed=falseを返す', async () => {
    const story = createStoryFile();
    const tasks = [createTaskFile()];
    const aiResponse = JSON.stringify([
      { criterion: 'ログインAPIが動作する', result: 'PASS', reason: 'OK' },
      { criterion: 'テストが通る', result: 'FAIL', reason: 'テスト未実装' },
      { criterion: 'ドキュメントが更新されている', result: 'FAIL', reason: '未更新' },
    ]);

    const deps = createFakeGateDeps({
      queryAI: vi.fn().mockResolvedValue(aiResponse),
    });

    const result = await checkAcceptanceCriteria(story, tasks, '/repo', deps);

    expect(result.allPassed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.results.filter((r) => r.result === 'FAIL')).toHaveLength(2);
  });

  it('受け入れ条件セクションがない場合、スキップしてallPassed=trueを返す', async () => {
    const story = createStoryFile({
      content: `
# ストーリー

## 概要

テスト

## タスク
`,
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = createFakeGateDeps();

    const result = await checkAcceptanceCriteria(story, [], '/repo', deps);

    expect(result.allPassed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.results).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('受け入れ条件セクションが見つかりません'),
    );

    consoleSpy.mockRestore();
  });

  it('Claude呼び出しにストーリー内容とPR情報を含むプロンプトが渡される', async () => {
    const story = createStoryFile();
    const tasks = [createTaskFile()];
    const queryAI = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'ログインAPIが動作する', result: 'PASS', reason: 'OK' },
        { criterion: 'テストが通る', result: 'PASS', reason: 'OK' },
        { criterion: 'ドキュメントが更新されている', result: 'PASS', reason: 'OK' },
      ]),
    );

    const deps = createFakeGateDeps({ queryAI });

    await checkAcceptanceCriteria(story, tasks, '/repo', deps);

    expect(queryAI).toHaveBeenCalledOnce();
    const prompt = queryAI.mock.calls[0][0];
    expect(prompt).toContain('ログインAPIが動作する');
    expect(prompt).toContain('テストが通る');
    expect(prompt).toContain('ドキュメントが更新されている');
  });

  it('マージ済みPRが収集されてプロンプトに含まれる', async () => {
    const story = createStoryFile();
    const tasks = [
      createTaskFile({ frontmatter: { status: 'Done', pr: 'https://github.com/test/repo/pull/1' } }),
    ];
    const queryAI = vi.fn().mockResolvedValue(
      JSON.stringify([
        { criterion: 'ログインAPIが動作する', result: 'PASS', reason: 'OK' },
        { criterion: 'テストが通る', result: 'PASS', reason: 'OK' },
        { criterion: 'ドキュメントが更新されている', result: 'PASS', reason: 'OK' },
      ]),
    );

    const deps = createFakeGateDeps({ queryAI });

    await checkAcceptanceCriteria(story, tasks, '/repo', deps);

    // execGh が呼ばれてPR情報が取得されたことを確認
    expect(deps.execGh).toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'view']),
      '/repo',
    );
  });
});
