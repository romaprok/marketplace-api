import type { Channel, ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import { WAREHOUSE_QUEUE } from './topology.js';
import { parseOrderPlaced, type OrderPlacedEvent } from './order-placed.event.js';

// One INSERT per message, a few ms (README has the measured number).
// prefetch=1 would leave the consumer idle for a network round trip after
// every ack. 20 keeps it busy, and even at a pessimistic 1 s per message
// 20 × 1 s = 20 s, nowhere near the 30 min consumer_timeout.
export const PREFETCH = 20;

export interface ConsumerHooks {
  onDelivery?(msg: ConsumeMessage): void;
  onEffect?(event: OrderPlacedEvent, applied: boolean, ms: number): void;
  beforeAck?(event: OrderPlacedEvent): Promise<void> | void;
  onAck?(event: OrderPlacedEvent): void;
  onReject?(msg: ConsumeMessage, requeue: boolean, err: Error): void;
  onCancel?(): void;
}

// The effect goes through the natural key: one fulfillment per order. A
// redelivered event hits the primary key and changes nothing, so the
// operation is safe to repeat without a separate "processed ids" table.
export async function applyEffect(ds: DataSource, event: OrderPlacedEvent): Promise<boolean> {
  const rows = await ds.query(
    `INSERT INTO fulfillments (order_id, event_id) VALUES ($1, $2)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING order_id`,
    [event.data.orderId, event.eventId],
  );
  return rows.length === 1;
}

function exitOnCancel(): void {
  console.error('[consumer] cancelled by the broker (queue deleted or consumer_timeout), exiting');
  process.exit(1);
}

export async function consumeOrderPlaced(
  ch: Channel,
  ds: DataSource,
  hooks: ConsumerHooks = {},
): Promise<string> {
  await ch.prefetch(PREFETCH);

  const { consumerTag } = await ch.consume(
    WAREHOUSE_QUEUE,
    async (msg) => {
      // null means the broker cancelled this consumer. `if (!msg) return`
      // would leave a process that looks alive while nothing reaches it.
      if (msg === null) {
        (hooks.onCancel ?? exitOnCancel)();
        return;
      }
      hooks.onDelivery?.(msg);

      let event: OrderPlacedEvent;
      try {
        event = parseOrderPlaced(msg.content);
      } catch (err) {
        // a body that can't be parsed won't parse on retry either
        ch.reject(msg, false);
        hooks.onReject?.(msg, false, err as Error);
        return;
      }

      try {
        const started = performance.now();
        const applied = await applyEffect(ds, event);
        hooks.onEffect?.(event, applied, performance.now() - started);
        await hooks.beforeAck?.(event);
        // ack only now: "I no longer need this redelivered". Before the
        // effect it would turn a crash into a lost order.
        ch.ack(msg);
        hooks.onAck?.(event);
      } catch (err) {
        // reject, not nack. On 4.2 both count toward x-delivery-limit, but
        // from 4.3 nack(requeue) doesn't, and the same code would spin the
        // message forever after an upgrade (measured: 9357 deliveries in
        // 20 s on 4.3.4, nothing in the DLQ)
        ch.reject(msg, true);
        hooks.onReject?.(msg, true, err as Error);
      }
    },
    { noAck: false },
  );
  return consumerTag;
}
