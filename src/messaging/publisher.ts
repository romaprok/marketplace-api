import type { ConfirmChannel } from 'amqplib';
import { EVENTS_EXCHANGE } from './topology.js';
import type { OrderPlacedEvent } from './order-placed.event.js';

// Resolves only after the broker confirmed it took the message. Without a
// confirm channel "published" would only mean "written to the socket".
// What the confirm does NOT mean is "routed somewhere": an unroutable
// message is confirmed too — that's what the alternate exchange is for.
export async function publishEvent(ch: ConfirmChannel, event: OrderPlacedEvent): Promise<void> {
  ch.publish(EVENTS_EXCHANGE, event.type, Buffer.from(JSON.stringify(event)), {
    persistent: true,
    contentType: 'application/json',
    messageId: event.eventId,
    type: event.type,
    timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
  });
  await ch.waitForConfirms();
}
