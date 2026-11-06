import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import type { RequestHandler } from 'express';

// What a log line wants to know about the request it belongs to. Nobody
// passes req down to the service or the repository for that: the store
// follows the request through every await on its own.
// The trace id is not here on purpose. It belongs to OpenTelemetry's active
// span, and a second copy of it here could only ever disagree.
// No tenant: the marketplace has one, there is nothing to tell apart.
export interface RequestContext {
  userId?: string;
  idempotencyKey?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const currentRequest = (): RequestContext | undefined => storage.getStore();

export function requestContext(): RequestHandler {
  return (req, _res, next) => {
    const idempotencyKey = req.get('idempotency-key');
    if (idempotencyKey) trace.getActiveSpan()?.setAttribute('marketplace.idempotency_key', idempotencyKey);
    storage.run({ idempotencyKey }, next);
  };
}

// After authenticate(): only now do we know who it is.
export const rememberUser: RequestHandler = (_req, res, next) => {
  const ctx = storage.getStore();
  const sub: string | undefined = res.locals.auth?.sub;
  if (ctx && sub) {
    ctx.userId = sub;
    trace.getActiveSpan()?.setAttribute('enduser.id', sub);
  }
  next();
};
