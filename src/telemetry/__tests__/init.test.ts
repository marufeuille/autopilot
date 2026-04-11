import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { initTelemetry, shutdownTelemetry } from '../init';
import type { TelemetryHandle } from '../init';

describe('initTelemetry', () => {
  let handle: TelemetryHandle | undefined;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    trace.disable();
  });

  afterEach(async () => {
    if (handle) {
      await handle.shutdown().catch(() => {});
      handle = undefined;
    }
    process.env = { ...originalEnv };
    trace.disable();
  });

  it('OTEL_ENABLED未設定の場合 enabled=false を返す', () => {
    delete process.env.OTEL_ENABLED;
    handle = initTelemetry();
    expect(handle.enabled).toBe(false);
    expect(handle.provider).toBeDefined();
  });

  it('OTEL_ENABLED=false の場合 enabled=false を返す', () => {
    process.env.OTEL_ENABLED = 'false';
    handle = initTelemetry();
    expect(handle.enabled).toBe(false);
  });

  it('OTEL_ENABLED=false の場合 shutdown が例外なく完了する', async () => {
    process.env.OTEL_ENABLED = 'false';
    handle = initTelemetry();
    await expect(shutdownTelemetry(handle)).resolves.toBeUndefined();
  });

  it('OTEL_ENABLED=true の場合 enabled=true を返す', () => {
    process.env.OTEL_ENABLED = 'true';
    handle = initTelemetry();
    expect(handle.enabled).toBe(true);
    expect(handle.provider).toBeDefined();
  });

  it('OTEL_ENABLED=true の場合 TracerProvider が取得でき、スパン生成が例外なく完了する', () => {
    process.env.OTEL_ENABLED = 'true';
    handle = initTelemetry();

    // SDK が有効な場合、tracer を取得してスパンを生成できる
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('test-span');
    span.setAttribute('test.key', 'value');
    span.end();
    // スパン生成自体が例外なく完了すればOK
    // (shutdown 時の gRPC 接続エラーはバックグラウンドで発生するためテストでは検証しない)
  });

  it('shutdown 関数が TelemetryHandle 経由で呼び出せる', async () => {
    process.env.OTEL_ENABLED = 'false';
    handle = initTelemetry();
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = undefined;
  });

  it('disabled 時にスパンを生成しても例外が発生しない', () => {
    process.env.OTEL_ENABLED = 'false';
    handle = initTelemetry();

    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('noop-span');
    span.setAttribute('key', 'value');
    span.end();
  });
});
