import { trace } from '@opentelemetry/api';
import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Structured JSON logger. Every line carries the service name and, when a span
 * is active, its trace_id/span_id so logs can be joined with traces.
 */
export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-hub-signature"]',
        'req.headers["x-hub-signature-256"]',
      ],
      censor: '[redacted]',
    },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
    ...options,
  });
}
