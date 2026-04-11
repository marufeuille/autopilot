import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, TracerProvider } from '@opentelemetry/api';

const SERVICE_NAME = 'autopilot';

export interface TelemetryHandle {
  provider: TracerProvider;
  enabled: boolean;
  shutdown: () => Promise<void>;
}

/**
 * OTel SDK を初期化する。
 *
 * - OTEL_ENABLED=false (または未設定) の場合、デフォルトの no-op プロバイダを返し外部通信は発生しない。
 * - OTEL_ENABLED=true の場合、OTLP gRPC exporter で Jaeger にトレースを送信する。
 */
export function initTelemetry(): TelemetryHandle {
  const enabled = process.env.OTEL_ENABLED === 'true';

  if (!enabled) {
    // デフォルトの ProxyTracerProvider は no-op として振る舞う
    const provider = trace.getTracerProvider();
    return {
      provider,
      enabled: false,
      shutdown: async () => {},
    };
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';

  const exporter = new OTLPTraceExporter({ url: endpoint });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
    }),
    traceExporter: exporter,
  });

  sdk.start();

  const provider = trace.getTracerProvider();

  return {
    provider,
    enabled: true,
    shutdown: async () => {
      await sdk.shutdown();
    },
  };
}

/**
 * TelemetryHandle 経由で SDK をシャットダウンする。
 * バッファ内のスパンをフラッシュしてからプロバイダをクリーンアップする。
 */
export async function shutdownTelemetry(handle: TelemetryHandle): Promise<void> {
  await handle.shutdown();
}
