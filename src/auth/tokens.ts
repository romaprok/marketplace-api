import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT, type JWTHeaderParameters } from 'jose';
import type { ApiEnv } from '../config/api-env.js';

export type Role = 'buyer' | 'seller' | 'admin';

export const ISSUER = 'marketplace-api';
export const AUDIENCE = 'marketplace-api';
// short on purpose: this is how long a stolen access token works if nothing
// else stops it, and how long a demoted admin stays admin
export const ACCESS_TTL_SEC = 10 * 60;
// RFC 9068 type, so an ID token or any other JWT signed by the same key
// can't be passed off as an access token
const TYP = 'at+jwt';

export interface AccessClaims {
  sub: string;
  role: Role;
  // refresh-token family: logout and reuse detection kill every access token of it
  fid: string;
  jti: string;
  iss: string;
  exp: number;
}

export interface Keys {
  kid: string;
  signing: KeyObject;
  // kid → public key. During an overlap rotation it holds two entries.
  verifying: Map<string, KeyObject>;
}

export function keysFrom(env: ApiEnv): Keys {
  const verifying = new Map([[env.JWT_KID, env.JWT_PUBLIC_KEY]]);
  if (env.JWT_PREV_KID && env.JWT_PREV_PUBLIC_KEY) verifying.set(env.JWT_PREV_KID, env.JWT_PREV_PUBLIC_KEY);
  return { kid: env.JWT_KID, signing: env.JWT_PRIVATE_KEY, verifying };
}

// what goes into logs and the README instead of the key itself
export function fingerprint(publicKey: KeyObject): string {
  return 'SHA256:' + createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
}

export async function signAccessToken(keys: Keys, user: { id: string; role: Role }, fid: string) {
  const jti = randomUUID();
  const token = await new SignJWT({ role: user.role, fid })
    .setProtectedHeader({ alg: 'ES256', kid: keys.kid, typ: TYP })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .setJti(jti)
    .sign(keys.signing);
  return { token, jti };
}

export async function verifyAccessToken(keys: Keys, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(
    token,
    (header: JWTHeaderParameters) => {
      const key = header.kid ? keys.verifying.get(header.kid) : undefined;
      if (!key) throw new Error(`unknown kid ${header.kid}`);
      return key;
    },
    {
      // the allowlist: whatever "alg" the header claims, only ES256 is accepted
      // (RFC 8725 §3.1, no algorithm confusion, no "none")
      algorithms: ['ES256'],
      issuer: ISSUER,
      audience: AUDIENCE,
      typ: TYP,
      requiredClaims: ['sub', 'jti', 'exp'],
    },
  );
  return payload as unknown as AccessClaims;
}
