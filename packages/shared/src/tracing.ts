import { register } from 'node:module';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;

/**
 * Start the OpenTelemetry SDK. Tracing stays off (no-op API) unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, so local runs and tests need no collector.
 *
 * Must run before application modules load (apps call it from instrumentation.ts
 * via `node --import`), because the ESM hook patches modules at import time.
 */
export function startTracing(serviceName: string): void {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new IORedisInstrumentation()],
  });
  sdk.start();
}

/** Flush pending spans. Call during graceful shutdown; no-op when tracing is off. */
export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

const tracer = trace.getTracer('reviewlens');

/** Run `fn` inside a new active span; records exceptions and ends the span. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
