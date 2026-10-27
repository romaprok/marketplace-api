// npm run demo:cache — cache-aside with TTL jitter, LRU eviction, and a
// stampede on the evicted key that costs exactly one trip to the database.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getProductCard, productCardKey } from './catalog/product-card.js';
import { finish, prepareDb, report } from './demo-kit.js';
import { QueryCountLogger } from './query-count-logger.js';
import { cacheBulkConnection, connectCache } from './redis/clients.js';

const PRODUCTS = 60;
const CONCURRENT = 25;
const WARM_READS = 100;
const COLD_VALUE = 'x'.repeat(4096);
const COLD_BATCH = 500;

async function configGet(redis: Redis, name: string): Promise<string> {
  const [, value] = (await redis.config('GET', name)) as [string, string];
  return value;
}

// cold keys from earlier runs; SCAN, never KEYS (KEYS blocks the server)
async function dropOldColdKeys(redis: Redis): Promise<void> {
  for await (const keys of redis.scanStream({ match: 'cold:*', count: 1000 })) {
    if ((keys as string[]).length) await redis.unlink(...(keys as string[]));
  }
}

async function main() {
  // counts every SQL statement that actually reaches Postgres: db-calls is
  // measured at the database client, not by counting our own function calls
  const counter = new QueryCountLogger();
  const ds = await prepareDb({ logging: ['query'], logger: counter });
  const podA = await connectCache();
  const podB = await connectCache();
  // the demo's own setup, checks and cold flood go through a connection
  // without the request-path timeout; the cards themselves go through the pods
  const bulk = cacheBulkConnection();
  await dropOldColdKeys(bulk);

  const policy = await configGet(bulk, 'maxmemory-policy');
  const maxmemory = Number(await configGet(bulk, 'maxmemory'));

  const [seller] = await ds.query(
    `INSERT INTO users (email, display_name) VALUES ('seller@demo.test', 'Demo Seller') RETURNING id`,
  );
  const rows: Array<{ id: string }> = await ds.query(
    `INSERT INTO products (name, price, seller_id, stock)
     SELECT 'Demo card ' || g, 10 + g, $1, 100 FROM generate_series(1, $2::int) g RETURNING id`,
    [seller.id, PRODUCTS],
  );
  const ids = rows.map((r) => r.id);
  const keys = ids.map(productCardKey);

  // 1. warm every card, then look at the TTLs the jitter produced
  for (const id of ids) await getProductCard(ds, podA, id);
  const warmed = await bulk.exists(...keys);
  const ttls = await Promise.all(keys.map((k) => bulk.ttl(k)));
  const ttlDistinct = new Set(ttls).size;

  // 2. pour cold data into a fresh namespace until LRU evicts some cards.
  // We take whichever card LRU picked, not a card chosen in advance.
  const ns = `cold:${randomUUID()}`;
  let coldWritten = 0;
  let evicted: string[] = [];
  for (let batch = 0; batch < 100 && evicted.length === 0; batch++) {
    const pipe = bulk.pipeline();
    for (let i = 0; i < COLD_BATCH; i++) pipe.set(`${ns}:${coldWritten++}`, COLD_VALUE, 'EX', 60);
    await pipe.exec();
    if ((await bulk.exists(...keys)) < keys.length) {
      const alive = await Promise.all(keys.map((k) => bulk.exists(k)));
      evicted = ids.filter((_, i) => alive[i] === 0);
    }
  }
  const target = evicted[0];
  if (!target) throw new Error(`nothing evicted after ${coldWritten} cold keys, is maxmemory set?`);

  // 3. stampede: CONCURRENT requests from two pods on the key that just vanished
  counter.reset();
  const started = performance.now();
  const cards = await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) => getProductCard(ds, i % 2 ? podB : podA, target)),
  );
  const stampedeMs = performance.now() - started;
  const dbCalls = counter.count;
  const sameCard = cards.every((c) => c?.id === target);

  // 4. the cache is warm again: reads shouldn't touch the database at all
  counter.reset();
  const warmStarted = performance.now();
  for (let i = 0; i < WARM_READS; i++) await getProductCard(ds, i % 2 ? podB : podA, target);
  const warmMsAvg = (performance.now() - warmStarted) / WARM_READS;
  const dbCallsWarm = counter.count;

  report({
    'cache-lru': policy !== 'noeviction' ? 1 : 0,
    'cache-maxmemory': maxmemory > 0 ? 1 : 0,
    warmed,
    'ttl-distinct': ttlDistinct,
    'ttl-min': Math.min(...ttls),
    'ttl-max': Math.max(...ttls),
    'cold-keys-written': coldWritten,
    evicted: evicted.length,
    concurrent: CONCURRENT,
    'db-calls': dbCalls,
    'stampede-ms': stampedeMs.toFixed(1),
    'db-calls-warm': dbCallsWarm,
    'warm-read-ms-avg': warmMsAvg.toFixed(2),
  });

  bulk.disconnect();
  podA.disconnect();
  podB.disconnect();
  await ds.destroy();

  finish(
    policy !== 'noeviction' && maxmemory > 0 && warmed >= 50 && ttlDistinct >= 5 && CONCURRENT >= 20 &&
      dbCalls === 1 && dbCallsWarm === 0 && sameCard,
    'a vanished key under a stampede costs one database call, a warm key none',
  );
}

main().catch((err) => {
  console.error('demo:cache failed:', err);
  process.exit(1);
});
