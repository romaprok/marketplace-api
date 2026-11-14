import { isSpanContextValid, trace } from '@opentelemetry/api';
import { pino } from 'pino';
import { currentRequest } from './context.js';

// One JSON object per line on stdout. Where it goes from there is the
// platform's job (kubectl logs, a collector), not the process's.
// Jest runs the repositories against a real database; their logs are noise there.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  // Read at the moment of every call, from whatever request is running now.
  // trace_id is the active span's: the same key the trace backend files the
  // spans under, so a line from the log opens the trace and back.
  mixin() {
    const span = trace.getActiveSpan()?.spanContext();
    const req = currentRequest();
    return {
      ...(span && isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : {}),
      user_id: req?.userId,
      idempotency_key: req?.idempotencyKey,
    };
  },
  // Exact paths only: redact doesn't guess, a password one level deeper than
  // listed here goes to the log as is. The access log puts headers and the
  // body of a failed request under req, so that's where these point.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.refresh_token',
      'req.body.email',
    ],
    censor: '[redacted]',
  },
});

// layer names the component: 'checkout.controller', 'orders.service', 'orders.repo'
export const loggerFor = (layer: string) => logger.child({ layer });
