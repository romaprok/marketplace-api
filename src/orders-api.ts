// The Postgres order API as its own process:
//   npm run build && npm run orders-api
// The hw-09 API (npm start) keeps its in-memory /v1/orders, which the
// hw-16 contract and the hw-18 realtime demo are built on.
import 'reflect-metadata';
import express from 'express';
import { AppDataSource } from './data-source.js';
import { checkoutRouter } from './http/checkout.route.js';

const port = Number(process.env.ORDERS_API_PORT ?? 3001);

async function main() {
  await AppDataSource.initialize();
  const app = express();
  app.use(checkoutRouter(AppDataSource));
  app.listen(port, () => console.log(`[orders-api] POST http://localhost:${port}/v1/checkout`));
}

main().catch((err) => {
  console.error('[orders-api] failed to start:', err.message);
  process.exit(1);
});
