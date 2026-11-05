// npm run demo:reuse — a refresh token used twice. The second use is the
// alarm: the whole family goes, the honest client's fresh token included.
import { decodeJwt } from 'jose';
import type { AccessClaims } from './auth/tokens.js';
import { call, createUser, login, refresh } from './demo-auth-kit.js';
import { finish, prepareDb, report } from './demo-kit.js';
import { demoRateLimitName, startPod } from './demo-redis-kit.js';

async function main() {
  const ds = await prepareDb();
  const pod = await startPod({ DEMO_RATE_LIMIT_NAME: demoRateLimitName() });
  try {
    const user = await createUser(ds, 'buyer');

    const first = await login(pod, user);
    const r1 = first.refresh;
    // the honest client refreshes: r1 is spent, r2 is the live one
    const r1Refresh = await refresh(pod, r1);
    const r2 = r1Refresh.refresh;
    // someone who copied r1 tries it now
    const r1Reuse = await refresh(pod, r1);
    // and the honest client, with a token that was valid a moment ago
    const r2AfterReuse = await refresh(pod, r2);
    // the access token r2 came with dies too, not only the refresh side
    const accessAfterReuse = await call(pod, 'GET', '/v1/me', { token: r1Refresh.access });

    const { fid } = decodeJwt(first.access) as unknown as AccessClaims;
    const [{ total, alive }] = await ds.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE revoked_at IS NULL)::int AS alive
         FROM refresh_tokens WHERE family_id = $1`,
      [fid],
    );
    const log = pod.log();
    const reuseLogged = log.includes('refresh token reuse detected') && log.includes(fid) ? 1 : 0;
    // tokens must never reach a log line
    const tokensInLog = [r1, r2, first.access, r1Refresh.access].filter((t) => log.includes(t)).length;

    report({
      login: first.status,
      'r1-refresh': r1Refresh.status,
      'r1-reuse': r1Reuse.status,
      'r2-after-reuse': r2AfterReuse.status,
      'access-after-reuse': accessAfterReuse.status,
      'family-tokens': total,
      'family-alive-tokens': alive,
      'reuse-logged': reuseLogged,
      'tokens-in-log': tokensInLog,
    });

    finish(
      first.status === 200 && r1Refresh.status === 200 && r1Reuse.status === 401 && r2AfterReuse.status === 401 &&
        accessAfterReuse.status === 401 && total === 2 && alive === 0 && reuseLogged === 1 && tokensInLog === 0,
      'a reused refresh token revokes the whole family',
    );
  } finally {
    await pod.close();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:reuse failed:', err);
  process.exit(1);
});
