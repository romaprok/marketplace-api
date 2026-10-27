// npm run demo:crash-write — the order transaction dies after its outbox row
// is already written. Both rows must disappear together, and nothing may
// reach the broker.
import { randomUUID } from 'node:crypto';
import { createBuyerAndProduct, finish, prepareDemo, report, sleep } from './demo-kit.js';
import { consumeOrderPlaced } from './messaging/order-placed.consumer.js';
import { relayOnce } from './messaging/outbox-relay.js';
import { placeOrder } from './place-order.js';

async function main() {
  const demo = await prepareDemo();
  const { buyerId, productId } = await createBuyerAndProduct(demo.ds);

  let deliveries = 0;
  let effect = 0;
  await consumeOrderPlaced(await demo.conn.createChannel(), demo.ds, {
    onDelivery: () => deliveries++,
    onEffect: (_e, applied) => {
      if (applied) effect++;
    },
  });

  const eventsOfBuyer = `SELECT count(*)::int AS n FROM outbox WHERE payload->'data'->>'buyerId' = $1`;
  let outboxBeforeCrash = 0;
  let writeFailed = 0;
  try {
    await placeOrder(
      demo.ds,
      { idempotencyKey: randomUUID(), buyerId, productId, quantity: 1 },
      {
        beforeCommit: async (manager) => {
          // proof that the outbox row really was written before the crash
          [{ n: outboxBeforeCrash }] = await manager.query(eventsOfBuyer, [buyerId]);
          throw new Error('simulated crash after the outbox insert, before COMMIT');
        },
      },
    );
  } catch {
    writeFailed = 1;
  }

  // the relay runs as usual; it must find nothing of this buyer to send
  await relayOnce(demo.ds, demo.pub);
  await sleep(500);

  const [{ n: orders }] = await demo.ds.query(`SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1`, [buyerId]);
  const [{ n: outbox }] = await demo.ds.query(eventsOfBuyer, [buyerId]);
  const [{ n: published }] = await demo.ds.query(`${eventsOfBuyer} AND published_at IS NOT NULL`, [buyerId]);
  const [{ stock }] = await demo.ds.query(`SELECT stock FROM products WHERE id = $1`, [productId]);

  report({
    'write-failed': writeFailed,
    'outbox-before-crash': outboxBeforeCrash,
    orders,
    outbox,
    published,
    deliveries,
    effect,
    'stock-left': stock,
  });
  await demo.close();

  finish(
    writeFailed === 1 && outboxBeforeCrash === 1 && orders === 0 && outbox === 0 && published === 0 &&
      deliveries === 0 && effect === 0 && stock === 100,
    'a failed order transaction leaves neither the order nor its event',
  );
}

main().catch((err) => {
  console.error('demo:crash-write failed:', err);
  process.exit(1);
});
