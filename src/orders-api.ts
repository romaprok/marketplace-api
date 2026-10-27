// The Postgres API as its own process:
//   npm run build && npm run orders-api
// The hw-09 API (npm start) keeps its in-memory /v1/orders, which the
// hw-16 contract and the hw-18 realtime demo are built on.
import 'reflect-metadata';
import { AppDataSource } from './data-source.js';
import { createApi } from './http/api.js';
import { connectCache, connectSessionStore } from './redis/clients.js';

const port = Number(process.env.ORDERS_API_PORT ?? 3001);

async function main() {
  await AppDataSource.initialize();
  const app = createApi({ ds: AppDataSource, cache: await connectCache(), sessionStore: await connectSessionStore() });
  app.listen(port, () => console.log(`[orders-api] listening on http://localhost:${port}/v1`));
}

main().catch((err) => {
  console.error('[orders-api] failed to start:', err.message);
  process.exit(1);
});
