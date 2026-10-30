import express from 'express';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { authenticate } from '../auth/middleware.js';
import type { Keys } from '../auth/tokens.js';
import { rateLimit } from '../ratelimit/sliding-window.js';
import type { Storage } from '../storage/s3.js';
import { sessions } from '../session/sessions.js';
import { authRouter } from './auth.route.js';
import { checkoutRouter } from './checkout.route.js';
import { ordersRouter } from './orders.route.js';
import { sendProblem } from './problem.js';
import { productCardRouter } from './product-card.route.js';
import { productsRouter } from './products.route.js';
import { uploadsRouter } from './uploads.route.js';

export interface ApiDeps {
  ds: DataSource;
  // allkeys-lru instance: cards and rate-limit counters, both fine to lose
  cache: Redis;
  // noeviction instance: sessions and the token denylist must not be evicted
  sessionStore: Redis;
  keys: Keys;
  pepper: string;
  // object storage for uploads (hw-26)
  storage: Storage;
  // the demos give each run its own limiter buckets; everything else uses 'api'
  rateLimitName?: string;
}

export const API_RATE_LIMIT = { limit: 20, windowMs: 10_000 };

// The Postgres API (npm start). Nothing is kept in process memory, so any
// number of instances behind a balancer share limits, sessions and the denylist.
export function createApi({ ds, cache, sessionStore, keys, pepper, storage, rateLimitName = 'api' }: ApiDeps): express.Express {
  const app = express();

  // Who is it: verifies a bearer token if there is one, rejects a bad one.
  // Whether they may do something is decided per route below.
  app.use(authenticate(keys, sessionStore));
  // Before sessions, so a flood of cookie-less requests can't mint sessions.
  // Per user when we know the user, per IP otherwise (login brute force).
  app.use(
    rateLimit(cache, {
      name: rateLimitName,
      ...API_RATE_LIMIT,
      key: (req, res) => res.locals.auth?.sub ?? req.ip ?? 'unknown',
    }),
  );
  app.use(sessions(sessionStore));

  app.use(authRouter({ ds, keys, pepper, denylist: sessionStore }));
  app.get('/v1/session', (req, res) => {
    if (!res.locals.session) return sendProblem(req, res, 503, 'Service Unavailable', 'session store unavailable');
    res.json(res.locals.session);
  });
  app.use(productCardRouter(ds, cache));
  app.use(productsRouter(ds));
  app.use(ordersRouter(ds));
  app.use(checkoutRouter(ds, cache));
  app.use(uploadsRouter(ds, storage));

  // an async handler that throws must still answer, and in problem+json
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api] unhandled error:', err);
    if (!res.headersSent) sendProblem(req, res, 500, 'Internal Server Error', 'unexpected error');
  });

  return app;
}
