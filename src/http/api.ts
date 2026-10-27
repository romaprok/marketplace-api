import express from 'express';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { rateLimit } from '../ratelimit/sliding-window.js';
import { sessions } from '../session/sessions.js';
import { checkoutRouter } from './checkout.route.js';
import { sendProblem } from './problem.js';
import { productCardRouter } from './product-card.route.js';

export interface ApiDeps {
  ds: DataSource;
  // allkeys-lru instance: cards and rate-limit counters, both fine to lose
  cache: Redis;
  // noeviction instance: sessions must not be evicted
  sessionStore: Redis;
}

export const API_RATE_LIMIT = { limit: 20, windowMs: 10_000 };

// The Postgres API (npm run orders-api). Nothing is kept in process memory,
// so any number of instances behind a balancer share limits and sessions.
export function createApi({ ds, cache, sessionStore }: ApiDeps): express.Express {
  const app = express();

  // Before sessions, so a flood of cookie-less requests can't mint sessions.
  // X-User-Id is the course's stand-in for identity until auth (hw-24).
  app.use(
    rateLimit(cache, { name: 'api', ...API_RATE_LIMIT, key: (req) => req.get('x-user-id') ?? req.ip ?? 'unknown' }),
  );
  app.use(sessions(sessionStore));

  app.get('/v1/session', (req, res) => {
    if (!res.locals.session) return sendProblem(req, res, 503, 'Service Unavailable', 'session store unavailable');
    res.json(res.locals.session);
  });
  app.use(productCardRouter(ds, cache));
  app.use(checkoutRouter(ds, cache));

  return app;
}
