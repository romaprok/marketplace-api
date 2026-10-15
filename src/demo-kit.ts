import 'reflect-metadata';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { DataSource } from 'typeorm';
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

// Known starting state for every demo: schema migrated, topology declared,
// both queues empty, rows from earlier runs gone. Without this a leftover
// message from a crashed run shows up in this run's numbers.
export async function prepareDemo(): Promise<Demo> {
  const ds = new DataSource(dataSourceOptions);
  await ds.initialize();
  await ds.runMigrations();

  // outbox and processed_messages don't hang off orders by FK, so they go
  // first, found through the buyer in the event payload
  const demoEvents = `SELECT id FROM outbox WHERE payload->'data'->>'buyerId' IN (SELECT id::text FROM users WHERE email LIKE $1)`;
  await ds.query(`DELETE FROM processed_messages WHERE message_id IN (SELECT id::text FROM (${demoEvents}) e)`, [DEMO_EMAIL]);
  await ds.query(`DELETE FROM outbox WHERE id IN (${demoEvents})`, [DEMO_EMAIL]);
  // orders cascade to order_items, tasks, fulfillments and idempotency_keys
  await ds.query(`DELETE FROM orders WHERE buyer_id IN (SELECT id FROM users WHERE email LIKE $1)`, [DEMO_EMAIL]);
  await ds.query(`DELETE FROM products WHERE seller_id IN (SELECT id FROM users WHERE email LIKE $1)`, [DEMO_EMAIL]);
  await ds.query(`DELETE FROM users WHERE email LIKE $1`, [DEMO_EMAIL]);

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
