import 'reflect-metadata';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { dataSourceOptions } from './data-source.js';
import { Product } from './entities/Product.js';
import { User } from './entities/User.js';
import { connectBroker } from './messaging/broker.js';
import { assertTopology, WAREHOUSE_DLQ, WAREHOUSE_QUEUE } from './messaging/topology.js';

export interface Demo {
  ds: DataSource;
  conn: ChannelModel;
  pub: ConfirmChannel;
  depth(queue: string): Promise<number>;
  close(): Promise<void>;
}

const DEMO_EMAIL = '%@demo.test';

// Schema migrated and rows from earlier runs gone. The Redis demos (hw-23)
// stop here, they don't need the broker.
// beforeCleanup runs while last run's demo users still exist: the hw-26 demos
// use it to remove their objects from storage, which no FK cascade reaches.
export async function prepareDb(
  options: Partial<DataSourceOptions> = {},
  beforeCleanup?: (ds: DataSource, demoEmail: string) => Promise<void>,
): Promise<DataSource> {
  const ds = new DataSource({ ...dataSourceOptions, ...options } as DataSourceOptions);
  await ds.initialize();
  await ds.runMigrations();
  await beforeCleanup?.(ds, DEMO_EMAIL);

  // outbox and processed_messages don't hang off orders by FK, so they go
  // first, found through the buyer in the event payload
  const demoEvents = `SELECT id FROM outbox WHERE payload->'data'->>'buyerId' IN (SELECT id::text FROM users WHERE email LIKE $1)`;
  await ds.query(`DELETE FROM processed_messages WHERE message_id IN (SELECT id::text FROM (${demoEvents}) e)`, [DEMO_EMAIL]);
  await ds.query(`DELETE FROM outbox WHERE id IN (${demoEvents})`, [DEMO_EMAIL]);
  // orders cascade to order_items, tasks, fulfillments and idempotency_keys
  await ds.query(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE $1)`, [DEMO_EMAIL]);
  await ds.query(`DELETE FROM products WHERE seller_id IN (SELECT id FROM users WHERE email LIKE $1)`, [DEMO_EMAIL]);
  await ds.query(`DELETE FROM users WHERE email LIKE $1`, [DEMO_EMAIL]);
  return ds;
}

// Known starting state for the broker demos: the above, plus topology
// declared and both queues empty. Without this a leftover message from a
// crashed run shows up in this run's numbers.
export async function prepareDemo(): Promise<Demo> {
  const ds = await prepareDb();
  const conn = await connectBroker();
  const pub = await conn.createConfirmChannel();
  await assertTopology(pub);
  await pub.purgeQueue(WAREHOUSE_QUEUE);
  await pub.purgeQueue(WAREHOUSE_DLQ);

  return {
    ds,
    conn,
    pub,
    depth: async (queue) => (await pub.checkQueue(queue)).messageCount,
    close: async () => {
      await conn.close();
      await ds.destroy();
    },
  };
}

export async function createBuyerAndProduct(ds: DataSource): Promise<{ buyerId: string; productId: string }> {
  const users = ds.getRepository(User);
  const products = ds.getRepository(Product);
  const seller = await users.save(users.create({ email: 'seller@demo.test', displayName: 'Demo Seller' }));
  const buyer = await users.save(
    users.create({ email: 'buyer@demo.test', displayName: 'Demo Buyer', balance: 10_000 }),
  );
  const product = await products.save(
    products.create({ seller, name: 'Demo product', price: 10, currency: 'UAH', stock: 100 }),
  );
  return { buyerId: buyer.id, productId: product.id };
}

export async function countFulfillments(ds: DataSource, orderIds: string[]): Promise<number> {
  const [{ n }] = await ds.query(`SELECT count(*)::int AS n FROM fulfillments WHERE order_id = ANY($1)`, [orderIds]);
  return n;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns false on timeout instead of throwing, so the demo still prints
// what it saw and fails on the invariant, not on a stack trace.
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

export function report(values: Record<string, number | string>): void {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
}

export function finish(ok: boolean, invariant: string): void {
  if (!ok) {
    console.error(`invariant violated: ${invariant}`);
    process.exitCode = 1;
  }
}
