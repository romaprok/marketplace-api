import type { ConfirmChannel } from 'amqplib';
import type { DataSource } from 'typeorm';
import type { OrderPlacedEvent } from './order-placed.event.js';
import { publishEvent } from './publisher.js';

export const RELAY_BATCH = 50;

export interface RelayHooks {
  // after the broker confirmed the whole batch, before published_at is written;
  // demo:crash-relay kills the process here
  afterPublish?(ids: string[]): Promise<void>;
}

// One pass over the outbox: lock a batch of unpublished rows, publish them,
// mark them published, all inside one transaction.
//
// SKIP LOCKED, not plain FOR UPDATE: both keep two relays off the same row,
// but with FOR UPDATE the second relay just waits for the first one's batch,
// so adding relays adds nothing.
//
// publish comes before UPDATE on purpose. Dying between the two publishes the
// batch again on the next pass (a duplicate, the consumer drops it). The other
// order would mark rows published and then maybe fail to publish them: a lost
// event, and nothing downstream can bring it back.
export async function relayOnce(ds: DataSource, ch: ConfirmChannel, hooks: RelayHooks = {}): Promise<number> {
  const qr = ds.createQueryRunner();
  await qr.connect();
  let ids: string[] = [];
  try {
    await qr.startTransaction();
    const rows: Array<{ id: string; payload: OrderPlacedEvent }> = await qr.query(
      `SELECT id, payload FROM outbox
       WHERE published_at IS NULL
       ORDER BY created_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [RELAY_BATCH],
    );
    ids = rows.map((r) => r.id);
    if (rows.length === 0) {
      await qr.commitTransaction();
      return 0;
    }

    for (const row of rows) await publishEvent(ch, row.payload);
    await hooks.afterPublish?.(ids);

    await qr.query(
      `UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    await qr.commitTransaction();
    return rows.length;
  } catch (err) {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    // the failed attempt still counts, outside the rolled-back transaction
    if (ids.length > 0) {
      await ds.query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])`, [ids]);
    }
    throw err;
  } finally {
    await qr.release();
  }
}
