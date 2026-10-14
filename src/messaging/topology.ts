import type { Channel } from 'amqplib';

export const EVENTS_EXCHANGE = 'shop.events';
export const UNROUTED_EXCHANGE = 'shop.unrouted';
export const UNROUTED_QUEUE = 'shop.unrouted';
export const DLX = 'shop.dlx';

export const ORDER_PLACED = 'order.placed';
export const WAREHOUSE_QUEUE = 'warehouse.order-placed';
export const WAREHOUSE_DLQ = 'warehouse.order-placed.dlq';

// Retries before a message that keeps failing is parked in the DLQ.
// Quorum queues count it themselves (x-delivery-count), the consumer
// doesn't have to.
export const DELIVERY_LIMIT = 3;

// Declared by the consumer side (or a bootstrap step), never by the
// producer: the producer publishes to shop.events and shouldn't know who
// listens. Every assert is idempotent, so running this on every start is
// fine — as long as the arguments don't change. Queue arguments are
// immutable: changing one here means deleting the queue first (406
// PRECONDITION_FAILED otherwise).
export async function assertTopology(ch: Channel): Promise<void> {
  // A routing key nobody is bound to is silently dropped, and the producer
  // still gets a positive confirm. The alternate exchange catches those.
  await ch.assertExchange(UNROUTED_EXCHANGE, 'fanout', { durable: true });
  await ch.assertQueue(UNROUTED_QUEUE, { durable: true });
  await ch.bindQueue(UNROUTED_QUEUE, UNROUTED_EXCHANGE, '');

  await ch.assertExchange(EVENTS_EXCHANGE, 'topic', {
    durable: true,
    alternateExchange: UNROUTED_EXCHANGE,
  });

  await ch.assertExchange(DLX, 'direct', { durable: true });
  // classic, not quorum: a quorum DLQ brings its own default delivery
  // limit, and someone inspecting it with get + nack could drop messages
  await ch.assertQueue(WAREHOUSE_DLQ, { durable: true, arguments: { 'x-queue-type': 'classic' } });
  await ch.bindQueue(WAREHOUSE_DLQ, DLX, WAREHOUSE_QUEUE);

  await ch.assertQueue(WAREHOUSE_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DLX,
      // its own key, so this queue's dead letters land in its own DLQ
      'x-dead-letter-routing-key': WAREHOUSE_QUEUE,
      'x-delivery-limit': DELIVERY_LIMIT,
    },
  });
  await ch.bindQueue(WAREHOUSE_QUEUE, EVENTS_EXCHANGE, ORDER_PLACED);
}
