import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// TTL = 300 + random(0..60) s. Keys warmed in one go must not expire in the
// same second, or the cache makes its own stampede.
export const BASE_TTL_SEC = 300;
export const TTL_JITTER_SEC = 60;

// longer than a cold load (tens of ms), short enough that a crashed holder
// doesn't keep everyone waiting
const LOCK_TTL_MS = 2_000;
const WAIT_STEP_MS = 25;
const WAIT_MAX_MS = 3_000;

// Compare-and-delete: only the token holder releases the lock. A bare DEL
// would drop a lock somebody else took after ours expired. Redis 8.4 has
// DELEX key IFEQ token for this, Lua works on any version.
const UNLOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

const DOWN = Symbol('redis down');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function jitteredTtl(): number {
  return BASE_TTL_SEC + Math.floor(Math.random() * (TTL_JITTER_SEC + 1));
}

// A cache that throws takes the request down with it. Every Redis call goes
// through here and a failure turns into DOWN, which callers treat as "go to
// the database".
async function safe<T>(op: () => Promise<T>): Promise<T | typeof DOWN> {
  try {
    return await op();
  } catch (err) {
    console.warn('[cache] redis call failed, falling back to the database:', (err as Error).message);
    return DOWN;
  }
}

async function read<T>(redis: Redis, key: string): Promise<T | undefined | typeof DOWN> {
  const raw = await safe(() => redis.get(key));
  if (raw === DOWN) return DOWN;
  return raw === null ? undefined : (JSON.parse(raw) as T);
}

// Cache-aside with a single-flight lock: on a miss exactly one caller (across
// all processes) loads from the database, the rest wait and re-read the
// cache. This is an optimization only. If the lock misbehaves, we load twice.
export async function cacheAside<T>(redis: Redis, key: string, load: () => Promise<T | null>): Promise<T | null> {
  const lockKey = `lock:${key}`;
  const deadline = Date.now() + WAIT_MAX_MS;

  for (;;) {
    const hit = await read<T>(redis, key);
    if (hit === DOWN) return load();
    if (hit !== undefined) return hit;

    const token = randomUUID();
    const locked = await safe(() => redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX'));
    if (locked === DOWN) return load();

    if (locked === 'OK') {
      try {
        // the previous holder may have filled the key between our GET and SET NX
        const again = await read<T>(redis, key);
        if (again !== undefined && again !== DOWN) return again;

        const value = await load();
        // a missing row isn't cached: nothing to protect, and no stale "not found"
        if (value !== null) await safe(() => redis.set(key, JSON.stringify(value), 'EX', jitteredTtl()));
        return value;
      } finally {
        await safe(() => redis.eval(UNLOCK, 1, lockKey, token));
      }
    }

    // the holder is stuck or slow: one more trip to the database beats a timeout
    if (Date.now() > deadline) return load();
    await sleep(WAIT_STEP_MS);
  }
}
