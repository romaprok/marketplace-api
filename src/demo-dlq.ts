// npm run demo:dlq — an event that can never be processed ends up in the
// DLQ instead of spinning in the work queue forever.
import { randomUUID } from 'node:crypto';
import { countFulfillments, finish, prepareDemo, report, waitFor } from './demo-kit.js';
import { consumeOrderPlaced } from './messaging/order-placed.consumer.js';
import { orderPlacedEvent } from './messaging/order-placed.event.js';
import { publishEvent } from './messaging/publisher.js';
import { DELIVERY_LIMIT, WAREHOUSE_DLQ, WAREHOUSE_QUEUE } from './messaging/topology.js';

const REASONS = ['rejected', 'expired', 'maxlen', 'delivery_limit'];

async function main() {
  const demo = await prepareDemo();

  let deliveries = 0;
  let rejected = 0;
  let effect = 0;
  let lastError = '';
  const consumerCh = await demo.conn.createChannel();
  const consumerTag = await consumeOrderPlaced(consumerCh, demo.ds, {
    onDelivery: () => deliveries++,
    onEffect: (_e, applied) => {
      if (applied) effect++;
    },
    onReject: (_msg, _requeue, err) => {
      rejected++;
      lastError = err.message;
    },
  });

  // A well-formed event about an order that doesn't exist: what a buggy
  // producer or a replay into the wrong environment looks like. The
  // fulfillments FK refuses it on every attempt, so retrying can't help.
  const orderId = randomUUID();
  await publishEvent(
    demo.pub,
    orderPlacedEvent({ orderId, buyerId: randomUUID(), productId: randomUUID(), quantity: 1, total: 10, currency: 'UAH' }),
  );

  await waitFor(async () => (await demo.depth(WAREHOUSE_DLQ)) === 1, 20_000);
  await consumerCh.cancel(consumerTag);

  // Read the dead letter like an operator would, then put it back so the
  // depth reported below is the real one.
  const inspect = await demo.conn.createChannel();
  const dead = await inspect.get(WAREHOUSE_DLQ, { noAck: false });
  const headers = dead ? (dead.properties.headers ?? {}) : {};
  const reason = String(headers['x-first-death-reason'] ?? 'none');
  const death = (headers['x-death'] as Array<Record<string, unknown>> | undefined)?.[0];
  if (dead) inspect.nack(dead, false, true);
  await waitFor(async () => (await demo.depth(WAREHOUSE_DLQ)) === 1, 5_000);

  const work = await demo.depth(WAREHOUSE_QUEUE);
  const dlq = await demo.depth(WAREHOUSE_DLQ);
  const rows = await countFulfillments(demo.ds, [orderId]);

  report({
    rejected,
    deliveries,
    'delivery-limit': DELIVERY_LIMIT,
    work,
    dlq,
    'dlq-reason': reason,
    effect,
    'fulfillment-rows': rows,
  });
  console.log(`# x-death: queue=${death?.queue} reason=${death?.reason} count=${death?.count}`);
  console.log(`# last consumer error: ${lastError}`);
  await demo.close();

  finish(
    work === 0 && dlq === 1 && REASONS.includes(reason) && effect === 0 && rows === 0 && rejected >= 1,
    'poison event parked in the DLQ with a readable reason, no effect applied',
  );
}

main().catch((err) => {
  console.error('demo:dlq failed:', err);
  process.exit(1);
});
