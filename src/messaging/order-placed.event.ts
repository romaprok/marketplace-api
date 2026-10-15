import { randomUUID } from 'node:crypto';

// The wire contract of order.placed. Designed on purpose, not an ORM entity
// spread into JSON: every later consumer reads this shape, and
// an entity changes whenever the schema does.
export interface OrderPlacedEvent {
  eventId: string;
  type: 'order.placed';
  version: 1;
  occurredAt: string;
  data: {
    orderId: string;
    buyerId: string;
    productId: string;
    quantity: number;
    total: number;
    currency: string;
  };
}

// eventId is the outbox row's id: the event is written once, then re-read
// from that row on every publish attempt, so a redelivery carries the same id.
export function orderPlacedEvent(data: OrderPlacedEvent['data'], eventId: string = randomUUID()): OrderPlacedEvent {
  return {
    eventId,
    type: 'order.placed',
    version: 1,
    occurredAt: new Date().toISOString(),
    data,
  };
}

export class MalformedEventError extends Error {}

export function parseOrderPlaced(content: Buffer): OrderPlacedEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString('utf8'));
  } catch {
    throw new MalformedEventError('body is not JSON');
  }
  const e = raw as Partial<OrderPlacedEvent>;
  if (e?.type !== 'order.placed' || e.version !== 1 || typeof e.eventId !== 'string') {
    throw new MalformedEventError('not an order.placed v1 event');
  }
  if (typeof e.data?.orderId !== 'string') {
    throw new MalformedEventError('data.orderId is missing');
  }
  return e as OrderPlacedEvent;
}
