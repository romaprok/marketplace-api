import type { RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import { sendProblem } from '../http/problem.js';
import { isDenied } from './denylist.js';
import { verifyAccessToken, type AccessClaims, type Keys, type Role } from './tokens.js';

// 401: we don't know who you are (no token, expired, broken, forged, revoked).
// The client's answer to it is a refresh. 403: we know exactly who you are,
// and the answer is no. A refresh won't change that, so the client shows an
// error. Mixing them up either loops on refresh or logs people out on every
// page they can't open.
function unauthorized(res: Response, detail: string): void {
  res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
  sendProblem(res.req, res, 401, 'Unauthorized', detail);
}

export const authOf = (res: Response): AccessClaims | undefined => res.locals.auth;

// Authentication only: who is this? No header means an anonymous request,
// and the routes decide whether that's enough. A header that doesn't verify
// is a 401 right here.
export function authenticate(keys: Keys, denylist: Redis): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization');
    if (!header) return next();
    const match = /^Bearer (\S+)$/i.exec(header);
    if (!match) return unauthorized(res, 'Authorization must be "Bearer <access token>"');

    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(keys, match[1]!);
    } catch {
      // the reason (bad signature, expired, wrong alg) is ours to know, not the caller's
      return unauthorized(res, 'access token is invalid or expired');
    }

    try {
      if (await isDenied(denylist, claims)) return unauthorized(res, 'access token was revoked');
    } catch (err) {
      // Fail closed: if we can't see the denylist we can't tell a revoked token
      // from a live one. 503, not 401, so clients don't start refreshing.
      console.warn('[auth] denylist unavailable:', (err as Error).message);
      return sendProblem(req, res, 503, 'Service Unavailable', 'cannot check token revocation right now');
    }
    res.locals.auth = claims;
    next();
  };
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!authOf(res)) return unauthorized(res, 'access token required');
  next();
};

// The role level only. Whether this particular order is yours isn't a
// guard's question: the guard runs before the order is loaded.
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    const auth = authOf(res);
    if (!auth) return unauthorized(res, 'access token required');
    if (!roles.includes(auth.role)) {
      return sendProblem(req, res, 403, 'Forbidden', `requires role ${roles.join(' or ')}`);
    }
    next();
  };
}
