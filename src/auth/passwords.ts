import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Argon2id is only in node:crypto from Node 24.7, the course runs on 22, so
// scrypt, which OWASP names as the fallback. N=2^15, r=8, p=3 is one of its
// equivalent settings: 32 MiB and roughly a hundred ms per hash.
const N_LOG2 = 15;
const R = 8;
const P = 3;
const KEY_LEN = 32;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const options = (nLog2: number, r: number, p: number): ScryptOptions => ({
  N: 2 ** nLog2,
  r,
  p,
  // the default 32 MiB cap is exactly our N × r × 128, leave some room
  maxmem: 64 * 1024 * 1024,
});

// scrypt$<log2 N>$<r>$<p>$<salt>$<hash>: parameters travel with the hash,
// so they can be raised later without breaking existing passwords
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, options(N_LOG2, R, P));
  return ['scrypt', N_LOG2, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), options(Number(n), Number(r), Number(p)));
  // constant time: how long the comparison takes says nothing about how much matched
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// For an unknown email we still spend one hash, so the response time
// doesn't tell which emails have accounts.
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword('no-such-user');
  await verifyPassword(password, await dummy);
}
