// Environment of the Postgres API (npm start) and its demo pods. Import it
// FIRST in an entry point: ESM evaluates imports in order, and data-source.ts
// already reads DB_URL when it's imported. Validating here first means a bare
// start without the vault names the missing variable instead of dying on the
// database connection.
import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { z } from 'zod';

// PEM travels base64-encoded: a multi-line export doesn't survive every shell
function keyFromBase64(b64: string, kind: 'private' | 'public'): KeyObject {
  const pem = Buffer.from(b64, 'base64').toString('utf8');
  const key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('must be an EC P-256 key (ES256)');
  }
  return key;
}

const privateKey = z.string().min(1).transform((v, ctx) => {
  try {
    return keyFromBase64(v, 'private');
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `not a base64 PKCS#8 PEM EC P-256 key: ${(err as Error).message}` });
    return z.NEVER;
  }
});
const publicKey = z.string().min(1).transform((v, ctx) => {
  try {
    return keyFromBase64(v, 'public');
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `not a base64 SPKI PEM EC P-256 key: ${(err as Error).message}` });
    return z.NEVER;
  }
});

// No defaults for anything secret: a default here is a key baked into the code.
const schema = z
  .object({
    DB_URL: z.string().url(),
    DB_PASSWORD_FILE: z.string().min(1).default('./secrets/db_password'),
    REDIS_URL: z.string().url(),
    REDIS_QUEUE_URL: z.string().url(),
    ORDERS_API_PORT: z.coerce.number().int().positive().default(3001),

    JWT_KID: z.string().min(1),
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    // the previous key during an overlap rotation: still verifies, never signs
    JWT_PREV_KID: z.string().min(1).optional(),
    JWT_PREV_PUBLIC_KEY: publicKey.optional(),
    REFRESH_TOKEN_PEPPER: z.string().min(32, 'at least 32 characters'),
  })
  .superRefine((env, ctx) => {
    // zod runs this even when a key above failed to parse; that key already has its own message
    const parsed = env.JWT_PRIVATE_KEY instanceof KeyObject && env.JWT_PUBLIC_KEY instanceof KeyObject;
    const probe = Buffer.from('key-pair-check');
    if (parsed && !verify('sha256', probe, env.JWT_PUBLIC_KEY, sign('sha256', probe, env.JWT_PRIVATE_KEY))) {
      ctx.addIssue({ code: 'custom', path: ['JWT_PUBLIC_KEY'], message: 'does not match JWT_PRIVATE_KEY' });
    }
    if (Boolean(env.JWT_PREV_KID) !== Boolean(env.JWT_PREV_PUBLIC_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_PREV_KID'], message: 'JWT_PREV_KID and JWT_PREV_PUBLIC_KEY go together' });
    }
  });

export type ApiEnv = z.infer<typeof schema>;

function load(): ApiEnv {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    console.error(`Invalid environment configuration:\n${problems}`);
    process.exit(1);
  }
  return result.data;
}

export const apiEnv = load();
