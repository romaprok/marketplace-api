// npm run demo:outbox — two requests with one Idempotency-Key give one
// order, one outbox event, one delivery and one effect.
import { randomUUID } from 'node:crypto';
import { countFulfillments, createBuyerAndProduct, finish, prepareDemo, report, sleep, waitFor } from './demo-kit.js';
import { CONSUMER, consumeOrderPlaced } from './messaging/order-placed.consumer.js';
import { relayOnce } from './messaging/outbox-relay.js';
import { placeOrder } from './place-order.js';

async function main() {
  const demo = await prepareDemo();
  const { buyerId, productId } = await createBuyerAndProduct(demo.ds);
  const [{ stock: stockBefore }] = await demo.ds.query(`SELECT stock FROM products WHERE id = $1`, [productId]);

  let deliveries = 0;
  let effect = 0;
  let acked = 0;
  await consumeOrderPlaced(await demo.conn.createChannel(), demo.ds, {
    onDelivery: () => deliveries++,
    onEffect: (_e, applied) => {
      if (applied) effect++;
    },
    onAck: () => acked++,
  });

  // a client that timed out and retried before the first answer came back:
  // the same key twice, at the same time
  const input = { idempotencyKey: randomUUID(), buyerId, productId, quantity: 1 };
  const results = await Promise.all([placeOrder(demo.ds, input), placeOrder(demo.ds, input)]);
  const requests = results.length;
  const sameOrder = results[0]!.orderId === results[1]!.orderId;

  const orderRows: Array<{ id: string }> = await demo.ds.query(`SELECT id FROM orders WHERE buyer_id = $1`, [buyerId]);
  const orderIds = orderRows.map((r) => r.id);
  const eventRows: Array<{ id: string }> = await demo.ds.query(`SELECT id FROM outbox WHERE aggregate_id = ANY($1)`, [orderIds]);
  const eventIds = eventRows.map((r) => r.id);

  await relayOnce(demo.ds, demo.pub);
  await waitFor(() => acked >= 1);
  // a bit longer, so an unexpected second delivery would still be counted
  await sleep(300);

  const [{ n: published }] = await demo.ds.query(
    `SELECT count(*)::int AS n FROM outbox WHERE id = ANY($1::uuid[]) AND published_at IS NOT NULL`,
    [eventIds],
  );
  const [{ n: processed }] = await demo.ds.query(
    `SELECT count(*)::int AS n FROM processed_messages WHERE message_id = ANY($1) AND consumer = $2`,
    [eventIds, CONSUMER],
  );
  const rows = await countFulfillments(demo.ds, orderIds);
  const [{ stock: stockAfter }] = await demo.ds.query(`SELECT stock FROM products WHERE id = $1`, [productId]);

  report({
    requests,
    orders: orderIds.length,
    outbox: eventIds.length,
    published,
    deliveries,
    effect,
    processed,
    'fulfillment-rows': rows,
    'stock-taken': stockBefore - stockAfter,
  });
  await demo.close();

  finish(
    requests === 2 && sameOrder && orderIds.length === 1 && eventIds.length === 1 && published === 1 &&
      deliveries === 1 && effect === 1 && processed === 1 && rows === 1 && stockBefore - stockAfter === 1,
    'two requests with one key: one order, one event, one effect',
  );
}

main().catch((err) => {
  console.error('demo:outbox failed:', err);
  process.exit(1);
});
