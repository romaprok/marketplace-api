// The consumer for demo:duplicate, in its own process so it can die for
// real: SIGKILL after the effect is committed and before the ack goes out.
// channel.close() would be a clean shutdown; a crashed pod at 3 a.m. is a
// process that vanishes and a socket the OS closes.
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source.js';
import { connectBroker } from './messaging/broker.js';
import { consumeOrderPlaced } from './messaging/order-placed.consumer.js';

export type ChildMessage =
  | { t: 'delivery'; redelivered: boolean }
  | { t: 'effect'; applied: boolean }
  | { t: 'crashing' };

const send = (m: ChildMessage) => new Promise<void>((resolve) => process.send!(m, () => resolve()));

async function main() {
  const ds = new DataSource(dataSourceOptions);
  await ds.initialize();
  const conn = await connectBroker();

  await consumeOrderPlaced(await conn.createChannel(), ds, {
    onDelivery: (msg) => void send({ t: 'delivery', redelivered: msg.fields.redelivered }),
    onEffect: (_e, applied) => void send({ t: 'effect', applied }),
    beforeAck: async () => {
      await send({ t: 'crashing' });
      process.kill(process.pid, 'SIGKILL');
    },
  });
}

main().catch((err) => {
  console.error('duplicate child failed:', err);
  process.exit(1);
});
