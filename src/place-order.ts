import type { ConfirmChannel } from 'amqplib';
import type { DataSource } from 'typeorm';
import { checkout, type CheckoutResult } from './checkout.js';
import { orderPlacedEvent } from './messaging/order-placed.event.js';
import { publishEvent } from './messaging/publisher.js';

// checkout() (hw-14) commits first, the event goes out after. There's no
// common COMMIT between Postgres and RabbitMQ, so a crash between the two
// leaves an order whose event never left. The transactional outbox in
// hw-22 closes exactly this gap; here it's knowingly open.
export async function placeOrder(
  ds: DataSource,
  ch: ConfirmChannel,
  buyerId: string,
  productId: string,
  quantity: number,
): Promise<CheckoutResult> {
  const result = await checkout(ds, buyerId, productId, quantity);
  await publishEvent(
    ch,
    orderPlacedEvent({
      orderId: result.orderId,
      buyerId,
      productId,
      quantity,
      total: result.total,
      currency: 'UAH',
    }),
  );
  return result;
}
