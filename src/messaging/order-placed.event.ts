// The wire contract of order.placed. Designed on purpose, not an ORM entity
// spread into JSON: consumers in hw-22/hw-23 will read the same shape, and
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

export function orderPlacedEvent(data: OrderPlacedEvent['data']): OrderPlacedEvent {
  return {
    // Derived from the order, not a fresh UUID: an order is placed once, so
    // re-publishing the "same" event after a lost confirm gives the same id.
    eventId: `order.placed:${data.orderId}`,
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
