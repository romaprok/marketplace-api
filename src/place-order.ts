import type { DataSource, EntityManager } from 'typeorm';
import { checkoutWith } from './checkout.js';
import { orderPlacedEvent } from './messaging/order-placed.event.js';

export interface PlaceOrderInput {
  // the client's Idempotency-Key: one key = one intent to buy, whatever the body
  idempotencyKey: string;
  buyerId: string;
  productId: string;
  quantity: number;
}

export interface PlaceOrderResult {
  orderId: string;
  // false when a request with the same key already placed this order
  created: boolean;
}

export class IdempotencyKeyReusedError extends Error {
  constructor(key: string) {
    super(`Idempotency-Key "${key}" was already used for a different order`);
    this.name = 'IdempotencyKeyReusedError';
  }
}

export interface PlaceOrderHooks {
  // runs inside the transaction right before COMMIT; demo:crash-write throws here
  beforeCommit?(manager: EntityManager): Promise<void>;
}

// The order, its outbox row and the idempotency key commit together or not
// at all. Nothing is published here: a broker can't roll back, so getting
// the event out is the relay's job, after COMMIT.
export async function placeOrder(
  ds: DataSource,
  input: PlaceOrderInput,
  hooks: PlaceOrderHooks = {},
): Promise<PlaceOrderResult> {
  return ds.transaction(async (manager) => {
    // Claim the key before touching stock or balance. A concurrent request
    // with the same key blocks on this INSERT until we commit, then hits the
    // conflict and returns our order instead of placing a second one.
    const claimed: unknown[] = await manager.query(
      `INSERT INTO idempotency_keys (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [input.idempotencyKey],
    );
    if (claimed.length === 0) {
      // Same key must mean the same intent. Another buyer or another item
      // under a reused key gets an error, not somebody else's order.
      // Compared in SQL, so uuid case doesn't matter.
      const [existing]: Array<{ order_id: string; same: boolean }> = await manager.query(
        `SELECT k.order_id, (o.buyer_id = $2 AND i.product_id = $3 AND i.quantity = $4) AS same
           FROM idempotency_keys k
           JOIN orders o ON o.id = k.order_id
           JOIN order_items i ON i.order_id = o.id
          WHERE k.key = $1`,
        [input.idempotencyKey, input.buyerId, input.productId, input.quantity],
      );
      if (!existing!.same) throw new IdempotencyKeyReusedError(input.idempotencyKey);
      return { orderId: existing!.order_id, created: false };
    }

    const { orderId, total } = await checkoutWith(manager, input.buyerId, input.productId, input.quantity);
    await manager.query(`UPDATE idempotency_keys SET order_id = $2 WHERE key = $1`, [
      input.idempotencyKey,
      orderId,
    ]);

    const event = orderPlacedEvent({
      orderId,
      buyerId: input.buyerId,
      productId: input.productId,
      quantity: input.quantity,
      total,
      currency: 'UAH',
    });
    await manager.query(
      `INSERT INTO outbox (id, aggregate_type, aggregate_id, type, payload) VALUES ($1, 'Order', $2, $3, $4)`,
      [event.eventId, orderId, event.type, JSON.stringify(event)],
    );

    await hooks.beforeCommit?.(manager);
    return { orderId, created: true };
  });
}
