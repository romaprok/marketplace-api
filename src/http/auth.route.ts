import express from 'express';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { denyFamily, denyOnLogout } from '../auth/denylist.js';
import { authOf, requireAuth } from '../auth/middleware.js';
import { burnPasswordCheck, verifyPassword } from '../auth/passwords.js';
import { revokeFamily, rotateRefreshToken, startFamily } from '../auth/refresh.js';
import { ACCESS_TTL_SEC, signAccessToken, type Keys, type Role } from '../auth/tokens.js';
import { handle } from './async.js';
import { sendProblem } from './problem.js';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refresh_token: z.string().min(1) });

export interface AuthDeps {
  ds: DataSource;
  keys: Keys;
  pepper: string;
  // noeviction instance, the denylist must not be evicted
  denylist: Redis;
}

// No token value ever reaches a log line, only jti and family ids.
export function authRouter({ ds, keys, pepper, denylist }: AuthDeps): express.Router {
  const router = express.Router();
  const json = express.json();

  const pair = async (user: { id: string; role: Role }, familyId: string, refresh: string) => {
    const access = await signAccessToken(keys, user, familyId);
    return { access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh };
  };

  router.post('/v1/auth/login', json, handle(async (req, res) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return sendProblem(req, res, 400, 'Bad Request', 'email and password are required');

    const [user]: Array<{ id: string; role: Role; password_hash: string | null }> = await ds.query(
      `SELECT id, role, password_hash FROM users WHERE email = $1`,
      [body.data.email],
    );
    if (!user?.password_hash) {
      await burnPasswordCheck(body.data.password);
      return sendProblem(req, res, 401, 'Unauthorized', 'wrong email or password');
    }
    if (!(await verifyPassword(body.data.password, user.password_hash))) {
      return sendProblem(req, res, 401, 'Unauthorized', 'wrong email or password');
    }

    const { familyId, refresh } = await startFamily(ds, pepper, user.id);
    console.log(`[auth] login user=${user.id} family=${familyId}`);
    res.json(await pair(user, familyId, refresh));
  }));

  router.post('/v1/auth/refresh', json, handle(async (req, res) => {
    const body = refreshSchema.safeParse(req.body);
    if (!body.success) return sendProblem(req, res, 400, 'Bad Request', 'refresh_token is required');

    const result = await rotateRefreshToken(ds, pepper, body.data.refresh_token);
    if (result.kind === 'reuse') {
      console.warn(
        `[auth] refresh token reuse detected: user=${result.userId} family=${result.familyId}, family revoked`,
      );
      // The refresh side is already dead in Postgres. The access tokens of the
      // family die here too; if Redis is down they live until exp, at most
      // ACCESS_TTL_SEC.
      await denyFamily(denylist, result.familyId).catch((err) =>
        console.warn('[auth] could not deny family access tokens:', (err as Error).message),
      );
    }
    if (result.kind !== 'rotated') return sendProblem(req, res, 401, 'Unauthorized', 'refresh token is invalid');

    res.json(await pair({ id: result.userId, role: result.role }, result.familyId, result.refresh));
  }));

  // Logout is two writes in two stores, and they are not atomic. Postgres
  // first: once the family is revoked no new access token can be minted. Then
  // the denylist for the access tokens already out there. If that second step
  // fails the client gets 503 and retries; both steps are idempotent.
  router.post('/v1/auth/logout', requireAuth, handle(async (req, res) => {
    const auth = authOf(res)!;
    await revokeFamily(ds, auth.fid);
    try {
      await denyOnLogout(denylist, auth);
    } catch (err) {
      console.warn(`[auth] logout family=${auth.fid}: denylist write failed:`, (err as Error).message);
      return sendProblem(req, res, 503, 'Service Unavailable', 'logout incomplete, retry');
    }
    console.log(`[auth] logout user=${auth.sub} family=${auth.fid} jti=${auth.jti}`);
    res.status(204).end();
  }));

  router.get('/v1/me', requireAuth, handle(async (req, res) => {
    const auth = authOf(res)!;
    const [user] = await ds.query(`SELECT id, email, display_name, role FROM users WHERE id = $1`, [auth.sub]);
    if (!user) return sendProblem(req, res, 401, 'Unauthorized', 'user no longer exists');
    // role from the table, the source of truth; token_role is the cached copy
    res.json({ ...user, token_role: auth.role });
  }));

  return router;
}
