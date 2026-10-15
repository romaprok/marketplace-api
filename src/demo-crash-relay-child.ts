// The relay for demo:crash-relay, in its own process so it can die for real:
// SIGKILL after the broker confirmed the publish, before published_at is
// written. The OS closes its sockets; Postgres rolls back the open
// transaction and releases the row lock on its own.
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source.js';
import { connectBroker } from './messaging/broker.js';
import { relayOnce } from './messaging/outbox-relay.js';

export type RelayChildMessage = { t: 'published'; n: number };

const send = (m: RelayChildMessage) => new Promise<void>((resolve) => process.send!(m, () => resolve()));

async function main() {
  const ds = new DataSource(dataSourceOptions);
  await ds.initialize();
  const conn = await connectBroker();
  const ch = await conn.createConfirmChannel();

  await relayOnce(ds, ch, {
    afterPublish: async (ids) => {
      await send({ t: 'published', n: ids.length });
      process.kill(process.pid, 'SIGKILL');
    },
  });
  // only reached when the outbox was empty
  await send({ t: 'published', n: 0 });
  process.exit(0);
}

main().catch((err) => {
  console.error('crash-relay child failed:', err);
  process.exit(1);
});
