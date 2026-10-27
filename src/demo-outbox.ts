// npm run demo:outbox — two HTTP requests with one Idempotency-Key give one
// order, one outbox event, one delivery and one effect.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { countFulfillments, createBuyerAndProduct, finish, prepareDemo, report, sleep, waitFor } from './demo-kit.js';
import { CONSUMER, consumeOrderPlaced } from './messaging/order-placed.consumer.js';
import { relayOnce } from './messaging/outbox-relay.js';
import { checkoutRouter } from './http/checkout.route.js';

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

  // The real route on a random free port. Authentication is hw-24's job and
  // not what this demo is about, so the buyer is set the way authenticate()
  // would set it after verifying a token.
  const server = express()
    .use((_req, res, next) => {
      res.locals.auth = { sub: buyerId };
      next();
    })
    .use(checkoutRouter(demo.ds))
    .listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/checkout`;
  const key = randomUUID();
  const post = (quantity: number) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ product_id: productId, quantity }),
    });

  // a client that timed out and retried before the first answer came back:
  // the same key twice, at the same time
  const responses = await Promise.all([post(1), post(1)]);
  const bodies: Array<{ order_id: string }> = await Promise.all(responses.map((r) => r.json()));
  const requests = responses.length;
  const created = responses.filter((r) => r.status === 201).length;
  const replayed = responses.filter((r) => r.headers.get('idempotency-replay') === 'true').length;
  const sameOrder = bodies[0]!.order_id === bodies[1]!.order_id;
  // the same key with another body is a client bug, not a retry
  const reuse = await post(2);
  server.close();

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
    'status-201': created,
    replayed,
    'key-reuse-422': reuse.status === 422 ? 1 : 0,
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
    requests === 2 && created === 2 && replayed === 1 && sameOrder && reuse.status === 422 && orderIds.length === 1 && eventIds.length === 1 && published === 1 &&
      deliveries === 1 && effect === 1 && processed === 1 && rows === 1 && stockBefore - stockAfter === 1,
    'two requests with one key: one order, one event, one effect',
  );
}

main().catch((err) => {
  console.error('demo:outbox failed:', err);
  process.exit(1);
});
