// npm run demo:session — one session across requests and a process restart,
// stored in Redis, with its TTL pushed forward by activity.
import { randomUUID } from 'node:crypto';
import { finish, report, sleep } from './demo-kit.js';
import { sessionIdFrom, startPod, type Pod } from './demo-redis-kit.js';
import { connectSessionStore } from './redis/clients.js';
import { sessionKey } from './session/sessions.js';

async function main() {
  const store = await connectSessionStore();
  // own rate-limit bucket, so other demos running nearby don't interfere
  const userId = randomUUID();
  const seen = new Set<string>();
  let requests = 0;
  let cookie = '';

  const get = async (pod: Pod) => {
    const res = await fetch(`${pod.url}/v1/session`, { headers: { cookie, 'x-user-id': userId } });
    requests++;
    const sid = sessionIdFrom(res);
    if (sid) {
      seen.add(sid);
      cookie = `sid=${sid}`;
    }
    return (await res.json()) as { requests: number };
  };

  let pod = await startPod();
  await get(pod);
  const sid = [...seen][0]!;

  // let the TTL tick down, then show that activity pushes it back up
  await sleep(1500);
  const ttlBefore = await store.pttl(sessionKey(sid));
  await get(pod);
  const ttlAfter = await store.pttl(sessionKey(sid));

  // restart: the pod process is killed and a new one starts with empty
  // memory. The session has to come back from Redis.
  await pod.close();
  pod = await startPod();
  const last = await get(pod);
  await pod.close();

  const inRedis = await store.exists(sessionKey(sid));
  await store.del(sessionKey(sid));
  store.disconnect();

  report({
    requests,
    sessions: seen.size,
    'in-redis': inRedis,
    'ttl-before-ms': ttlBefore,
    'ttl-after-ms': ttlAfter,
    'ttl-renewed': ttlAfter > ttlBefore ? 1 : 0,
    restarted: 1,
    'session-requests': last.requests,
  });

  finish(
    requests >= 3 && seen.size === 1 && inRedis === 1 && ttlAfter > ttlBefore && last.requests === requests,
    'one session in Redis for all requests, renewed by activity, alive after a restart',
  );
}

main().catch((err) => {
  console.error('demo:session failed:', err);
  process.exit(1);
});
