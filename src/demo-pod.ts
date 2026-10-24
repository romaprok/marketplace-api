// One pod for demo:session and demo:ratelimit: the Postgres API in its own
// process. Two pods share nothing but Redis, and killing one really throws
// its memory away, so an in-process limit or session store can't pass.
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { AppDataSource } from './data-source.js';
import { createApi } from './http/api.js';
import { connectCache, connectSessionStore } from './redis/clients.js';

export type PodMessage = { port: number };

async function main() {
  await AppDataSource.initialize();
  const app = createApi({ ds: AppDataSource, cache: await connectCache(), sessionStore: await connectSessionStore() });
  const server = app.listen(0, '127.0.0.1', () => {
    process.send!({ port: (server.address() as AddressInfo).port } satisfies PodMessage);
  });
  // the demo exiting without killing us must not leave a pod behind
  process.on('disconnect', () => process.exit(0));
}

main().catch((err) => {
  console.error('[pod] failed to start:', err.message);
  process.exit(1);
});
