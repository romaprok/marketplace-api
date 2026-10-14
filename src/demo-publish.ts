// npm run demo:publish — five orders, five events, five fulfillments.
import { countFulfillments, createBuyerAndProduct, finish, prepareDemo, report, sleep, waitFor } from './demo-kit.js';
import { consumeOrderPlaced, PREFETCH } from './messaging/order-placed.consumer.js';
import { WAREHOUSE_DLQ, WAREHOUSE_QUEUE } from './messaging/topology.js';
import { placeOrder } from './place-order.js';

const N = 5;

async function main() {
  const demo = await prepareDemo();
  const { buyerId, productId } = await createBuyerAndProduct(demo.ds);

  let delivered = 0;
  let effect = 0;
  let acked = 0;
  const effectMs: number[] = [];
  await consumeOrderPlaced(await demo.conn.createChannel(), demo.ds, {
    onDelivery: () => delivered++,
    onEffect: (_e, applied, ms) => {
      if (applied) effect++;
      effectMs.push(ms);
    },
    onAck: () => acked++,
  });

  const orderIds: string[] = [];
  for (let i = 0; i < N; i++) {
    const { orderId } = await placeOrder(demo.ds, demo.pub, buyerId, productId, 1);
    orderIds.push(orderId);
  }
  const published = orderIds.length;

  await waitFor(() => acked >= N);
  // a bit longer, so an unexpected extra delivery would still be counted
  await sleep(300);

  const rows = await countFulfillments(demo.ds, orderIds);
  const work = await demo.depth(WAREHOUSE_QUEUE);
  const dlq = await demo.depth(WAREHOUSE_DLQ);
  const avg = effectMs.reduce((a, b) => a + b, 0) / Math.max(effectMs.length, 1);

  report({
    published,
    delivered,
    effect,
    acked,
    work,
    dlq,
    prefetch: PREFETCH,
    'fulfillment-rows': rows,
    'effect-ms-avg': avg.toFixed(1),
  });
  await demo.close();

  finish(
    published === N && delivered === N && effect === N && acked === N && rows === N && work === 0 && dlq === 0,
    `${N} published → ${N} delivered → ${N} effects, nothing left in work or DLQ`,
  );
}

main().catch((err) => {
  console.error('demo:publish failed:', err);
  process.exit(1);
});
