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
  isNoAdditionalTasksComment,
  buildAdditionalTasksPrompt,
  generateAdditionalTasks,
  AdditionalTasksDeps,
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

  it('AI応答のパースに失敗した場合、エラーメッセージを含む例外をスローする', async () => {
    const story = createStoryFile();
    const tasks = [createTaskFile()];

    const deps = createFakeGateDeps({
      queryAI: vi.fn().mockResolvedValue('これはJSONではない不正な応答'),
    });

    await expect(
      checkAcceptanceCriteria(story, tasks, '/repo', deps),
    ).rejects.toThrow('受け入れ条件チェックのAI応答パースに失敗しました');
  });
});

// --- isNoAdditionalTasksComment ---

describe('isNoAdditionalTasksComment', () => {
  it('「追加タスク不要」を含むコメントはtrueを返す', () => {
    expect(isNoAdditionalTasksComment('追加タスク不要です')).toBe(true);
  });

  it('「タスク不要」を含むコメントはtrueを返す', () => {
    expect(isNoAdditionalTasksComment('タスク不要')).toBe(true);
  });

  it('「追加不要」を含むコメントはtrueを返す', () => {
    expect(isNoAdditionalTasksComment('追加不要です')).toBe(true);
  });

  it('「問題ない」を含むコメントはtrueを返す', () => {
    expect(isNoAdditionalTasksComment('問題ないのでDoneにしてください')).toBe(true);
  });

  it('「問題なし」を含むコメントはtrueを返す', () => {
    expect(isNoAdditionalTasksComment('問題なし')).toBe(true);
  });

  it('「そのまま」を含むコメントはtrueを返す', () => {
    expect(isNoAdditionalTasksComment('そのままDoneにして')).toBe(true);
  });

  it('英語の "no additional tasks" もtrueを返す', () => {
    expect(isNoAdditionalTasksComment('no additional tasks')).toBe(true);
    expect(isNoAdditionalTasksComment('No Additional Task')).toBe(true);
  });

  it('通常のコメントはfalseを返す', () => {
    expect(isNoAdditionalTasksComment('テストを追加してください')).toBe(false);
    expect(isNoAdditionalTasksComment('ログイン機能のバリデーションが足りない')).toBe(false);
  });
});

// --- buildAdditionalTasksPrompt ---

describe('buildAdditionalTasksPrompt', () => {
  it('ストーリー・既存タスク・コメント・FAIL条件を含むプロンプトを構築する', () => {
    const story = createStoryFile();
    const tasks = [createTaskFile()];
    const comment = 'テストが不足しています';
    const failedCriteria: CriterionResult[] = [
      { criterion: 'テストが通る', result: 'FAIL', reason: 'テスト未実装' },
    ];

    const prompt = buildAdditionalTasksPrompt(story, tasks, comment, failedCriteria);

    expect(prompt).toContain('テストが不足しています');
    expect(prompt).toContain('[FAIL] テストが通る: テスト未実装');
    expect(prompt).toContain('test-story-01');
    expect(prompt).toContain('"test-story-');
  });

  it('既存タスクが空の場合は「（なし）」と表示する', () => {
    const story = createStoryFile();
    const prompt = buildAdditionalTasksPrompt(story, [], 'コメント', []);

    expect(prompt).toContain('（なし）');
  });

  it('FAIL条件が空の場合は「（なし）」と表示する', () => {
    const story = createStoryFile();
    const prompt = buildAdditionalTasksPrompt(story, [createTaskFile()], 'コメント', []);

    expect(prompt).toContain('受け入れ条件チェックで FAIL だった項目\n（なし）');
  });
});

// --- generateAdditionalTasks ---

describe('generateAdditionalTasks', () => {
  const story = createStoryFile();
  const tasks = [createTaskFile()];
  const failedCriteria: CriterionResult[] = [
    { criterion: 'テストが通る', result: 'FAIL', reason: 'テスト未実装' },
  ];

  function createFakeAdditionalDeps(overrides: Partial<AdditionalTasksDeps> = {}): AdditionalTasksDeps {
    return {
      queryAI: vi.fn().mockResolvedValue('[]'),
      ...overrides,
    };
  }

  it('「追加タスク不要」コメントの場合、空配列を返しAIを呼ばない', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = createFakeAdditionalDeps();

    const result = await generateAdditionalTasks(story, tasks, '追加タスク不要です', failedCriteria, deps);

    expect(result).toEqual([]);
    expect(deps.queryAI).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('Claudeが生成したタスク案をバリデーションして返す', async () => {
    const aiResponse = JSON.stringify([
      {
        slug: 'test-story-fix-tests',
        title: 'テストの追加',
        priority: 'high',
        effort: 'medium',
        purpose: '不足しているテストを追加する',
        detail: 'ログインAPIのユニットテストを追加する',
        criteria: ['テストが通る', 'カバレッジ80%以上'],
      },
    ]);

    const deps = createFakeAdditionalDeps({
      queryAI: vi.fn().mockResolvedValue(aiResponse),
    });

    const result = await generateAdditionalTasks(story, tasks, 'テストを追加してください', failedCriteria, deps);

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('test-story-fix-tests');
    expect(result[0].title).toBe('テストの追加');
    expect(result[0].priority).toBe('high');
    expect(result[0].effort).toBe('medium');
    expect(result[0].criteria).toEqual(['テストが通る', 'カバレッジ80%以上']);
  });

  it('コードブロック付きの応答もパースできる', async () => {
    const aiResponse = '```json\n' + JSON.stringify([
      {
        slug: 'test-story-fix-01',
        title: '修正タスク',
        priority: 'medium',
        effort: 'low',
        purpose: '修正する',
        detail: '修正の詳細',
        criteria: ['修正完了'],
      },
    ]) + '\n```';

    const deps = createFakeAdditionalDeps({
      queryAI: vi.fn().mockResolvedValue(aiResponse),
    });

    const result = await generateAdditionalTasks(story, tasks, '修正してください', failedCriteria, deps);

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('test-story-fix-01');
  });

  it('不正なJSONの場合はエラーをスローする', async () => {
    const deps = createFakeAdditionalDeps({
      queryAI: vi.fn().mockResolvedValue('不正なJSON'),
    });

    await expect(
      generateAdditionalTasks(story, tasks, 'テストを追加', failedCriteria, deps),
    ).rejects.toThrow('追加タスク生成のJSONパースに失敗しました');
  });

  it('バリデーションエラーの場合はvalidateTaskDraftsからのエラーがスローされる', async () => {
    const aiResponse = JSON.stringify([
      {
        slug: 'invalid slug with spaces',
        title: 'テスト',
        priority: 'high',
        effort: 'low',
        purpose: '目的',
        detail: '詳細',
        criteria: ['条件'],
      },
    ]);

    const deps = createFakeAdditionalDeps({
      queryAI: vi.fn().mockResolvedValue(aiResponse),
    });

    await expect(
      generateAdditionalTasks(story, tasks, 'テストを追加', failedCriteria, deps),
    ).rejects.toThrow('バリデーションエラー');
  });

  it('複数タスクが生成される場合も正しくバリデーションされる', async () => {
    const aiResponse = JSON.stringify([
      {
        slug: 'test-story-add-tests',
        title: 'テスト追加',
        priority: 'high',
        effort: 'medium',
        purpose: 'テストを追加する',
        detail: 'ユニットテストの追加',
        criteria: ['テスト追加'],
      },
      {
        slug: 'test-story-update-docs',
        title: 'ドキュメント更新',
        priority: 'low',
        effort: 'low',
        purpose: 'ドキュメントを更新する',
        detail: 'READMEの更新',
        criteria: ['ドキュメント更新'],
      },
    ]);

    const deps = createFakeAdditionalDeps({
      queryAI: vi.fn().mockResolvedValue(aiResponse),
    });

    const result = await generateAdditionalTasks(story, tasks, 'テストとドキュメントを追加して', failedCriteria, deps);

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('test-story-add-tests');
    expect(result[1].slug).toBe('test-story-update-docs');
  });

  it('FAIL条件とコメントがプロンプトに含まれることを確認', async () => {
    const queryAI = vi.fn().mockResolvedValue(JSON.stringify([
      {
        slug: 'test-story-fix-01',
        title: '修正',
        priority: 'high',
        effort: 'low',
        purpose: '修正する',
        detail: '詳細',
        criteria: ['完了'],
      },
    ]));

    const deps = createFakeAdditionalDeps({ queryAI });
    const userComment = 'バリデーションが不足しているので追加してください';

    await generateAdditionalTasks(story, tasks, userComment, failedCriteria, deps);

    expect(queryAI).toHaveBeenCalledOnce();
    const prompt = queryAI.mock.calls[0][0];
    expect(prompt).toContain(userComment);
    expect(prompt).toContain('[FAIL] テストが通る');
  });
});
