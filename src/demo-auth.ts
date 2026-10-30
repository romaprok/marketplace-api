// npm run demo:auth — login, access with and without a token, refresh, and a
// logout that kills both tokens: the refresh family in Postgres, the access
// token through the denylist.
import { decodeJwt } from 'jose';
import { denyTtl } from './auth/denylist.js';
import type { AccessClaims } from './auth/tokens.js';
import { call, createUser, login, refresh } from './demo-auth-kit.js';
import { finish, prepareDb, report } from './demo-kit.js';
import { demoRateLimitName, startPod } from './demo-redis-kit.js';
import { connectSessionStore } from './redis/clients.js';

async function main() {
  const ds = await prepareDb();
  const store = await connectSessionStore();
  const pod = await startPod({ DEMO_RATE_LIMIT_NAME: demoRateLimitName() });
  try {
    const user = await createUser(ds, 'buyer');

    const first = await login(pod, user);
    const noToken = await call(pod, 'GET', '/v1/me');
    const withToken = await call(pod, 'GET', '/v1/me', { token: first.access });
    const rotated = await refresh(pod, first.refresh);

    const logout = await call(pod, 'POST', '/v1/auth/logout', { token: rotated.access });
    const afterLogout = await call(pod, 'GET', '/v1/me', { token: rotated.access });
    const refreshAfterLogout = await refresh(pod, rotated.refresh);
    // the access token from the login itself, same family, still before its exp
    const oldAccessAfterLogout = await call(pod, 'GET', '/v1/me', { token: first.access });

    const claims = decodeJwt(rotated.access) as unknown as AccessClaims;
    const ttl = await denyTtl(store, claims);
    const [{ alive }] = await ds.query(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS alive FROM refresh_tokens WHERE family_id = $1`,
      [claims.fid],
    );

    report({
      login: first.status,
      'no-token': noToken.status,
      'with-token': withToken.status,
      refresh: rotated.status,
      logout: logout.status,
      'after-logout': afterLogout.status,
      'refresh-after-logout': refreshAfterLogout.status,
      'old-access-after-logout': oldAccessAfterLogout.status,
      'deny-ttl-sec': ttl,
      'family-alive-tokens': alive,
    });

    finish(
      first.status === 200 && noToken.status === 401 && withToken.status === 200 && rotated.status === 200 &&
        (logout.status === 200 || logout.status === 204) && afterLogout.status === 401 &&
        refreshAfterLogout.status === 401 && oldAccessAfterLogout.status === 401 && ttl > 0 && ttl <= 601 && alive === 0,
      'logout kills the refresh family and the access token before its exp',
    );
  } finally {
    await pod.close();
    store.disconnect();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:auth failed:', err);
  process.exit(1);
});
