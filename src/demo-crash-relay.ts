// npm run demo:crash-relay — the relay dies between publish and
// UPDATE published_at. The event goes out twice; the effect happens once.
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RelayChildMessage } from './demo-crash-relay-child.js';
import { countFulfillments, createBuyerAndProduct, finish, prepareDemo, report, sleep, waitFor } from './demo-kit.js';
import { CONSUMER, consumeOrderPlaced } from './messaging/order-placed.consumer.js';
import { relayOnce } from './messaging/outbox-relay.js';
import { placeOrder } from './place-order.js';

function runCrashingRelay(): Promise<{ events: RelayChildMessage[]; signal: NodeJS.Signals | null }> {
  const child = fork(fileURLToPath(new URL('./demo-crash-relay-child.js', import.meta.url)), {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const events: RelayChildMessage[] = [];
  child.on('message', (m) => events.push(m as RelayChildMessage));
  const guard = setTimeout(() => child.kill('SIGTERM'), 15_000);
  return new Promise((resolve) =>
    child.once('exit', (_code, signal) => {
      clearTimeout(guard);
      resolve({ events, signal });
    }),
  );
}

async function main() {
  const demo = await prepareDemo();
  const { buyerId, productId } = await createBuyerAndProduct(demo.ds);
  const { orderId } = await placeOrder(demo.ds, { idempotencyKey: randomUUID(), buyerId, productId, quantity: 1 });
  const [{ id: eventId }] = await demo.ds.query(`SELECT id FROM outbox WHERE aggregate_id = $1`, [orderId]);

  let deliveries = 0;
  let applied = 0;
  let skipped = 0;
  await consumeOrderPlaced(await demo.conn.createChannel(), demo.ds, {
    onDelivery: (msg) => {
      if (msg.properties.messageId === eventId) deliveries++;
    },
    onEffect: (e, wasApplied) => {
      if (e.eventId !== eventId) return;
      if (wasApplied) applied++;
      else skipped++;
    },
  });

  // 1. publish confirmed, process killed before UPDATE published_at
  const crashed = await runCrashingRelay();
  const publishedBeforeKill = crashed.events.find((e) => e.t === 'published')?.n ?? 0;
  const [{ published_at: afterKill }] = await demo.ds.query(`SELECT published_at FROM outbox WHERE id = $1`, [eventId]);

  // 2. a healthy relay finds the same row still unpublished and sends it again;
  // the dead relay's lock may need a moment to go away, SKIP LOCKED just skips it
  const isPublished = async () => {
    const [{ published_at }] = await demo.ds.query(`SELECT published_at FROM outbox WHERE id = $1`, [eventId]);
    return published_at !== null;
  };
  await waitFor(async () => {
    await relayOnce(demo.ds, demo.pub);
    return isPublished();
  }, 10_000);
  await waitFor(() => applied + skipped >= 2);
  await sleep(300);

  const [{ n: published }] = await demo.ds.query(
    `SELECT count(*)::int AS n FROM outbox WHERE id = $1 AND published_at IS NOT NULL`,
    [eventId],
  );
  const [{ n: processed }] = await demo.ds.query(
    `SELECT count(*)::int AS n FROM processed_messages WHERE message_id = $1 AND consumer = $2`,
    [eventId, CONSUMER],
  );
  const effect = await countFulfillments(demo.ds, [orderId]);

  report({
    killed: crashed.signal === 'SIGKILL' ? 1 : 0,
    'published-before-kill': publishedBeforeKill,
    'unpublished-after-kill': afterKill === null ? 1 : 0,
    published,
    deliveries,
    applied,
    skipped,
    effect,
    processed,
  });
  await demo.close();

  finish(
    crashed.signal === 'SIGKILL' && publishedBeforeKill === 1 && afterKill === null && published === 1 &&
      deliveries >= 2 && applied === 1 && effect === 1 && processed === 1,
    'the event was delivered twice, the effect happened once',
  );
}

main().catch((err) => {
  console.error('demo:crash-relay failed:', err);
  process.exit(1);
});
