import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';

// Rolling: every request pushes the expiry 30 min forward, so an active
// user is never logged out mid-work and an idle one is gone after 30 min.
export const SESSION_TTL_SEC = 30 * 60;
const COOKIE = 'sid';
const SID = /^[A-Za-z0-9_-]{43}$/;

export const sessionKey = (id: string) => `sess:${id}`;

export interface Session {
  createdAt: string;
  lastSeenAt: string;
  requests: number;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

// Own token state on a Redis hash. The process keeps nothing, so any
// instance (or a restarted one) picks the session up.
export function sessions(store: Redis): RequestHandler {
  return async (req, res, next) => {
    try {
      let id = readCookie(req.get('cookie'), COOKIE);
      const now = new Date().toISOString();
      // EXPIRE only touches an existing key: it renews a live session and
      // can't bring an expired one back
      const alive = id && SID.test(id) ? await store.expire(sessionKey(id), SESSION_TTL_SEC) : 0;

      const tx = store.multi();
      if (alive === 1) {
        tx.hincrby(sessionKey(id!), 'requests', 1).hset(sessionKey(id!), 'lastSeenAt', now);
      } else {
        id = randomBytes(32).toString('base64url');
        tx.hset(sessionKey(id), { createdAt: now, lastSeenAt: now, requests: 1 }).expire(sessionKey(id), SESSION_TTL_SEC);
      }
      const results = (await tx.hgetall(sessionKey(id!)).exec()) ?? [];
      const failed = results.find(([err]) => err);
      if (failed) throw failed[0];

      const raw = results.at(-1)![1] as Record<string, string>;
      res.locals.session = { createdAt: raw.createdAt, lastSeenAt: raw.lastSeenAt, requests: Number(raw.requests) };
      // the cookie rolls together with the Redis TTL
      res.cookie(COOKIE, id, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: SESSION_TTL_SEC * 1000,
      });
    } catch (err) {
      // no store, no session; public pages still work, GET /v1/session says 503
      console.warn('[session] store unavailable:', (err as Error).message);
    }
    next();
  };
}
