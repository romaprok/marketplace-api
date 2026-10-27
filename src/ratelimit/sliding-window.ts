import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { sendProblem } from '../http/problem.js';

// Sliding window log in one Lua script. ZREMRANGEBYSCORE + ZCARD + ZADD sent
// from Node would let another pod slip in between ZCARD and ZADD, and the
// limit would leak exactly under load. The clock is Redis TIME, so pods with
// drifting clocks still agree on where the window is.
const SLIDING_WINDOW = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, tonumber(oldest[2]) + window - now}
`;

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowMs: number;
  key(req: Request): string;
}

export function rateLimit(redis: Redis, opts: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    let allowed: number;
    let retryMs: number;
    try {
      [allowed, retryMs] = (await redis.eval(
        SLIDING_WINDOW,
        1,
        `rl:${opts.name}:${opts.key(req)}`,
        opts.windowMs,
        opts.limit,
        randomUUID(),
      )) as [number, number];
    } catch (err) {
      // fail open: the limiter protects capacity, not correctness, and a
      // dead Redis shouldn't turn into a dead API
      console.warn('[ratelimit] store unavailable, letting the request through:', (err as Error).message);
      return next();
    }
    if (allowed === 1) return next();

    res.set('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))));
    sendProblem(req, res, 429, 'Too Many Requests', `At most ${opts.limit} requests per ${opts.windowMs / 1000} s.`);
  };
}
