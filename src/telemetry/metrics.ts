import client from '@prometheus-io/client';
import type { Request, RequestHandler, Response } from 'express';
import { loggerFor } from './logger.js';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// Upper bounds in seconds. The top finite one has to sit above the slowest
// request we actually see, or histogram_quantile flattens at that bound
// exactly when things go bad. See README, Observability, buckets.
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

// RED: Rate and Errors from the counter, Duration from the histogram.
// route is the template (/v1/orders/:orderId), never the raw path: a label
// value is a time series, and a raw path is one more series per id.
const requests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route template and status code',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

const duration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by method and route template',
  labelNames: ['method', 'route'] as const,
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

const log = loggerFor('http');

// Whatever ended before a route matched: an unknown path (404), a bad token
// (401 from authenticate), the rate limiter (429). One value for all of them.
const UNMATCHED = 'unmatched';
const routeOf = (req: Request): string => (req.route ? req.baseUrl + String(req.route.path) : UNMATCHED);

function finished(req: Request, res: Response, seconds: number): void {
  const route = routeOf(req);
  const status = res.statusCode;
  requests.inc({ method: req.method, route, status: String(status) });
  duration.observe({ method: req.method, route }, seconds);

  const line: Record<string, unknown> = { method: req.method, route, status, duration_ms: Math.round(seconds * 1000) };
  // A failed request is the one someone will come looking for, so it carries
  // the headers and the body. The secrets in them are redact's job (logger.ts).
  if (status >= 400) line.req = { url: req.originalUrl, headers: req.headers, body: req.body };
  log[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'](line, 'request finished');
}

// One place for the access log and both metrics, so they can't disagree
// about what happened. The 'finish' listener is created inside the request,
// so it runs with the request's context: the access line gets its trace_id.
export function observeRequests(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => finished(req, res, Number(process.hrtime.bigint() - started) / 1e9));
    next();
  };
}

export const metricsHandler: RequestHandler = async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
};
