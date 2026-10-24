// npm run demo:duplicate — the same event delivered twice, the effect
// applied once.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildMessage } from './demo-duplicate-child.js';
import { countFulfillments, createBuyerAndProduct, finish, prepareDemo, report, sleep, waitFor } from './demo-kit.js';
import { consumeOrderPlaced } from './messaging/order-placed.consumer.js';
import { WAREHOUSE_DLQ, WAREHOUSE_QUEUE } from './messaging/topology.js';
import { placeOrder } from './place-order.js';

function runCrashingConsumer(): Promise<{ events: ChildMessage[]; signal: NodeJS.Signals | null }> {
  const child = fork(fileURLToPath(new URL('./demo-duplicate-child.js', import.meta.url)), {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const events: ChildMessage[] = [];
  child.on('message', (m) => events.push(m as ChildMessage));
  // if the child never gets the message, don't hang the demo
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

  // published while nobody consumes, so the child gets it first
  const { orderId } = await placeOrder(demo.ds, demo.pub, buyerId, productId, 1);

  // 1. effect committed, process killed before the ack
  const crashed = await runCrashingConsumer();
  let deliveries = crashed.events.filter((e) => e.t === 'delivery').length;
  let effect = crashed.events.filter((e) => e.t === 'effect' && e.applied).length;
  let skipped = crashed.events.filter((e) => e.t === 'effect' && !e.applied).length;

  // the broker requeues once it notices the dead socket
  await waitFor(async () => (await demo.depth(WAREHOUSE_QUEUE)) === 1, 10_000);

  // 2. a healthy consumer gets the same event again
  let redelivered = 0;
  let acked = 0;
  await consumeOrderPlaced(await demo.conn.createChannel(), demo.ds, {
    onDelivery: (msg) => {
      deliveries++;
      if (msg.fields.redelivered) redelivered++;
    },
    onEffect: (_e, applied) => (applied ? effect++ : skipped++),
    onAck: () => acked++,
  });
  await waitFor(() => acked >= 1);
  await sleep(300);

  const rows = await countFulfillments(demo.ds, [orderId]);
  const work = await demo.depth(WAREHOUSE_QUEUE);
  const dlq = await demo.depth(WAREHOUSE_DLQ);

  report({
    published: 1,
    killed: crashed.signal === 'SIGKILL' ? 1 : 0,
    deliveries,
    redelivered,
    effect,
    skipped,
    'fulfillment-rows': rows,
    work,
    dlq,
  });
  await demo.close();

  finish(
    crashed.signal === 'SIGKILL' && deliveries >= 2 && effect === 1 && skipped >= 1 && rows === 1 && work === 0 && dlq === 0,
    'two deliveries of one event, one effect',
  );
}

main().catch((err) => {
  console.error('demo:duplicate failed:', err);
  process.exit(1);
});
