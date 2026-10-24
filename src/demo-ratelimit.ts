// npm run demo:ratelimit — two pods, one client, one shared limit.
import { randomUUID } from 'node:crypto';
import { finish, report } from './demo-kit.js';
import { sessionIdFrom, startPod } from './demo-redis-kit.js';
import { API_RATE_LIMIT } from './http/api.js';
import { connectSessionStore } from './redis/clients.js';
import { sessionKey } from './session/sessions.js';


async function main() {
  // two processes: a counter kept in process memory would let 2 × limit through
  const pods = [await startPod(), await startPod()];
  // a fresh client id per run, so an earlier run's window doesn't count
  const userId = randomUUID();
  // more than 2 × limit, so two separate counters would show up as allowed = 2 × limit
  const total = 2 * API_RATE_LIMIT.limit + 5;

  // first request picks up a cookie, so the rest reuse one session
  const first = await fetch(`${pods[0]!.url}/v1/session`, { headers: { 'x-user-id': userId } });
  const sid = sessionIdFrom(first)!;

  // the rest at once, round-robin over the pods
  const rest = await Promise.all(
    Array.from({ length: total - 1 }, (_, i) =>
      fetch(`${pods[(i + 1) % 2]!.url}/v1/session`, { headers: { 'x-user-id': userId, cookie: `sid=${sid}` } }),
    ),
  );
  const responses = [first, ...rest];
  const allowed = responses.filter((r) => r.status === 200).length;
  const blockedResponses = responses.filter((r) => r.status === 429);
  const lastBlocked = blockedResponses.at(-1);
  const retryAfter = lastBlocked?.headers.get('retry-after');
  await Promise.all(responses.map((r) => r.body?.cancel()));

  for (const pod of pods) await pod.close();
  const store = await connectSessionStore();
  await store.del(sessionKey(sid));
  store.disconnect();

  report({
    instances: pods.length,
    limit: API_RATE_LIMIT.limit,
    'window-ms': API_RATE_LIMIT.windowMs,
    requests: responses.length,
    allowed,
    blocked: blockedResponses.length,
    status: lastBlocked?.status ?? 0,
    'retry-after': retryAfter ? 1 : 0,
    'retry-after-sec': Number(retryAfter ?? 0),
  });

  finish(
    pods.length >= 2 && allowed === API_RATE_LIMIT.limit && blockedResponses.length >= 1 &&
      lastBlocked?.status === 429 && Boolean(retryAfter),
    'two pods share one limit: exactly `limit` requests pass, the rest get 429 with Retry-After',
  );
}

main().catch((err) => {
  console.error('demo:ratelimit failed:', err);
  process.exit(1);
});
