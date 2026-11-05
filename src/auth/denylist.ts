import type { Redis } from 'ioredis';
import { ACCESS_TTL_SEC, type AccessClaims } from './tokens.js';

// Lives on the noeviction instance: under allkeys-lru a denied token could be
// evicted and come back to life. Every key dies with the token it denies,
// so the list never grows past the tokens alive right now.
const jtiKey = (c: Pick<AccessClaims, 'iss' | 'jti'>) => `deny:jti:${c.iss}:${c.jti}`;
const familyKey = (fid: string) => `deny:fam:${fid}`;

const secondsLeft = (exp: number) => Math.max(1, exp - Math.floor(Date.now() / 1000) + 1);

// logout: this token by jti, plus the family, which also covers the access
// tokens the same login got from earlier refreshes and that are still alive
export async function denyOnLogout(store: Redis, claims: AccessClaims): Promise<void> {
  await store
    .multi()
    .set(jtiKey(claims), '1', 'EX', secondsLeft(claims.exp))
    .set(familyKey(claims.fid), '1', 'EX', ACCESS_TTL_SEC + 1)
    .exec();
}

// reuse detected: we have no access token in hand, only the family
export async function denyFamily(store: Redis, fid: string): Promise<void> {
  await store.set(familyKey(fid), '1', 'EX', ACCESS_TTL_SEC + 1);
}

export async function isDenied(store: Redis, claims: AccessClaims): Promise<boolean> {
  return (await store.exists(jtiKey(claims), familyKey(claims.fid))) > 0;
}

export function denyTtl(store: Redis, claims: AccessClaims): Promise<number> {
  return store.ttl(jtiKey(claims));
}
