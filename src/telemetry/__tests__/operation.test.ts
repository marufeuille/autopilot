import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { traceOperation, setCurrentStepContext, getCurrentStepContext } from '../operation';

describe('traceOperation', () => {
  beforeEach(() => {
    setCurrentStepContext(undefined);
  });

  afterEach(() => {
    setCurrentStepContext(undefined);
  });

  it('Operation スパンが生成され op.type, op.wait_type が属性に設定される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    await traceOperation(
      { type: 'agent', waitType: 'agent' },
      async () => 'result',
    );

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'op:agent',
      {
        attributes: {
          'op.type': 'agent',
          'op.wait_type': 'agent',
        },
      },
      expect.anything(),
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('op.error', false);
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('正常終了時に op.error=false が設定される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    await traceOperation(
      { type: 'ci-poll', waitType: 'ci' },
      async () => 'ok',
    );

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('op.error', false);
    expect(mockSpan.setStatus).not.toHaveBeenCalled();
  });

  it('エラー時に op.error=true と ERROR ステータスが設定される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    await expect(
      traceOperation(
        { type: 'agent', waitType: 'agent' },
        async () => { throw new Error('test error'); },
      ),
    ).rejects.toThrow('test error');

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('op.error', true);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('getResult コールバックで op.token_input, op.token_output が記録される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    const result = await traceOperation(
      { type: 'agent', waitType: 'agent' },
      async () => ({ usage: { inputTokens: 100, outputTokens: 200 } }),
      (r) => ({ tokenInput: r.usage.inputTokens, tokenOutput: r.usage.outputTokens }),
    );

    expect(result).toEqual({ usage: { inputTokens: 100, outputTokens: 200 } });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('op.token_input', 100);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('op.token_output', 200);
  });

  it('getResult コールバックが undefined のトークン値を渡した場合、属性が設定されない', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    await traceOperation(
      { type: 'review', waitType: 'agent' },
      async () => 'ok',
      () => ({}),
    );

    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('op.token_input', expect.anything());
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('op.token_output', expect.anything());
  });

  it('ラップされた関数の戻り値がそのまま返される', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    const result = await traceOperation(
      { type: 'slack-approval', waitType: 'human' },
      async () => ({ action: 'approve' }),
    );

    expect(result).toEqual({ action: 'approve' });
  });

  it('エラー時にもスパンが終了する（finally ブロックの検証）', async () => {
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    try {
      await traceOperation(
        { type: 'git-sync', waitType: 'agent' },
        async () => { throw new Error('sync failed'); },
      );
    } catch { /* expected */ }

    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it('currentStepContext が設定されている場合、それを親コンテキストとして使用する', async () => {
    const mockStepContext = { _type: 'step-context' } as any;
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    setCurrentStepContext(mockStepContext);

    await traceOperation(
      { type: 'agent', waitType: 'agent' },
      async () => 'ok',
    );

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'op:agent',
      expect.anything(),
      mockStepContext,
    );
  });

  it('currentStepContext が未設定の場合、context.active() を親コンテキストとして使用する', async () => {
    const activeContext = context.active();
    const mockSpan = {
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    await traceOperation(
      { type: 'ci-poll', waitType: 'ci' },
      async () => 'ok',
    );

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'op:ci-poll',
      expect.anything(),
      activeContext,
    );
  });

  it('各オペレーション種別 (agent / review / ci-poll / slack-approval / git-sync) でスパンが正しく生成される', async () => {
    const types = [
      { type: 'agent' as const, waitType: 'agent' as const },
      { type: 'review' as const, waitType: 'agent' as const },
      { type: 'ci-poll' as const, waitType: 'ci' as const },
      { type: 'slack-approval' as const, waitType: 'human' as const },
      { type: 'git-sync' as const, waitType: 'agent' as const },
    ];

    for (const { type, waitType } of types) {
      const mockSpan = {
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        end: vi.fn(),
      };
      const mockTracer = {
        startSpan: vi.fn().mockReturnValue(mockSpan),
      };
      vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

      await traceOperation(
        { type, waitType },
        async () => 'ok',
      );

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        `op:${type}`,
        {
          attributes: {
            'op.type': type,
            'op.wait_type': waitType,
          },
        },
        expect.anything(),
      );
    }
  });
});

describe('setCurrentStepContext / getCurrentStepContext', () => {
  afterEach(() => {
    setCurrentStepContext(undefined);
  });

  it('コンテキストの設定と取得が正しく動作する', () => {
    const ctx = { _type: 'test' } as any;

    expect(getCurrentStepContext()).toBeUndefined();

    setCurrentStepContext(ctx);
    expect(getCurrentStepContext()).toBe(ctx);

    setCurrentStepContext(undefined);
    expect(getCurrentStepContext()).toBeUndefined();
  });
});

describe('traceOperation セキュリティ', () => {
  it('スパンに会話テキスト・ファイルパス・コマンド内容が含まれない', async () => {
    const setAttributeCalls: Array<[string, any]> = [];
    const mockSpan = {
      setAttribute: vi.fn((k: string, v: any) => setAttributeCalls.push([k, v])),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const mockTracer = {
      startSpan: vi.fn().mockReturnValue(mockSpan),
    };
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as any);

    await traceOperation(
      { type: 'agent', waitType: 'agent' },
      async () => 'secret content should not appear',
      () => ({ tokenInput: 42, tokenOutput: 84 }),
    );

    // 記録された属性キーの検証
    const allKeys = setAttributeCalls.map(([k]) => k);
    expect(allKeys).toEqual(
      expect.arrayContaining(['op.token_input', 'op.token_output', 'op.error']),
    );

    // 許可されたキーのみ
    for (const key of allKeys) {
      expect([
        'op.type', 'op.wait_type', 'op.error',
        'op.token_input', 'op.token_output',
      ]).toContain(key);
    }

    // 値にシークレット情報が含まれない
    for (const [_, value] of setAttributeCalls) {
      expect(String(value)).not.toContain('secret');
    }

    // startSpan の attributes も検証
    const startAttrs = mockTracer.startSpan.mock.calls[0][1]?.attributes ?? {};
    for (const [key, value] of Object.entries(startAttrs)) {
      expect(['op.type', 'op.wait_type']).toContain(key);
      expect(String(value)).not.toContain('secret');
    }
  });
});
