// One pod for demo:session and demo:ratelimit: the Postgres API in its own
// process. Two pods share nothing but Redis, and killing one really throws
// its memory away, so an in-process limit or session store can't pass.
// The hw-29 demos start it with tracing (node --import) and use the two
// knobs below: a fixed port Prometheus can scrape, and a checkout that fails
// on purpose.
import { apiEnv } from './config/api-env.js';
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { keysFrom } from './auth/tokens.js';
import { AppDataSource } from './data-source.js';
import { createApi } from './http/api.js';
import { connectCache, connectSessionStore } from './redis/clients.js';
import { createStorage } from './storage/s3.js';
import { FAIL_KEY_PREFIX } from './demo-obs-kit.js';
import { currentRequest } from './telemetry/context.js';

export type PodMessage = { port: number };

async function main() {
  await AppDataSource.initialize();
  const app = createApi({
    ds: AppDataSource,
    cache: await connectCache(),
    sessionStore: await connectSessionStore(),
    keys: keysFrom(apiEnv),
    pepper: apiEnv.REFRESH_TOKEN_PEPPER,
    storage: createStorage(apiEnv),
    // a fresh limiter namespace per demo run, so one run's requests don't
    // count against the next one
    rateLimitName: process.env.DEMO_RATE_LIMIT_NAME,
    // A real 500 from deep inside, after the stock and balance writes and
    // with a rollback, not a route that just answers 500.
    placeOrderHooks: {
      beforeCommit: async () => {
        if (currentRequest()?.idempotencyKey?.startsWith(FAIL_KEY_PREFIX)) {
          throw new Error('injected failure before COMMIT');
        }
      },
    },
  });
  const server = app.listen(Number(process.env.DEMO_POD_PORT ?? 0), '127.0.0.1', () => {
    process.send!({ port: (server.address() as AddressInfo).port } satisfies PodMessage);
  });
  // the demo exiting without killing us must not leave a pod behind
  process.on('disconnect', () => process.exit(0));
}

main().catch((err) => {
  console.error('[pod] failed to start:', err.message);
  process.exit(1);
});
