import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import type { Role } from './tokens.js';

export const REFRESH_TTL_DAYS = 14;

// Opaque on purpose: a random string means nothing outside our table and
// can be killed by one UPDATE.
const newToken = () => randomBytes(32).toString('base64url');

// HMAC with a pepper from the vault: with the table alone you can't even
// check a guessed token against a row
export const hashRefreshToken = (pepper: string, token: string) =>
  createHmac('sha256', pepper).update(token).digest('hex');

async function insertToken(manager: EntityManager, pepper: string, userId: string, familyId: string): Promise<string> {
  const token = newToken();
  await manager.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, familyId, hashRefreshToken(pepper, token), REFRESH_TTL_DAYS],
  );
  return token;
}

// login: a new family with its first token
export async function startFamily(ds: DataSource, pepper: string, userId: string) {
  const familyId = randomUUID();
  const refresh = await insertToken(ds.manager, pepper, userId, familyId);
  return { familyId, refresh };
}

export type RotateResult =
  | { kind: 'rotated'; userId: string; role: Role; familyId: string; refresh: string }
  | { kind: 'reuse'; userId: string; familyId: string }
  | { kind: 'invalid' };

// Every refresh spends its token and hands out the next one in the same
// family. A token that was already spent means two parties hold it, and we
// can't tell which one is the thief, so the whole family goes.
// Marking, revoking and issuing share one transaction: the row lock makes two
// concurrent refreshes with one token run one after the other, and the second
// sees used_at.
export async function rotateRefreshToken(ds: DataSource, pepper: string, presented: string): Promise<RotateResult> {
  return ds.transaction(async (manager) => {
    const [row]: Array<{
      id: string;
      user_id: string;
      family_id: string;
      used_at: Date | null;
      revoked_at: Date | null;
      expired: boolean;
      role: Role;
    }> = await manager.query(
      `SELECT t.id, t.user_id, t.family_id, t.used_at, t.revoked_at, t.expires_at < now() AS expired, u.role
         FROM refresh_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1
          FOR UPDATE OF t`,
      [hashRefreshToken(pepper, presented)],
    );
    if (!row || row.revoked_at) return { kind: 'invalid' } as const;

    if (row.used_at) {
      await manager.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [
        row.family_id,
      ]);
      return { kind: 'reuse', userId: row.user_id, familyId: row.family_id } as const;
    }
    if (row.expired) return { kind: 'invalid' } as const;

    await manager.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    const refresh = await insertToken(manager, pepper, row.user_id, row.family_id);
    // the role comes from the users table, so every refresh refreshes the copy in the token
    return { kind: 'rotated', userId: row.user_id, role: row.role, familyId: row.family_id, refresh } as const;
  });
}

export async function revokeFamily(ds: DataSource, familyId: string): Promise<void> {
  await ds.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
}
