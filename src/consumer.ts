// The warehouse consumer as a long-running process:
//   npm run build && npm run consumer
import 'reflect-metadata';
import { AppDataSource } from './data-source.js';
import { connectBroker } from './messaging/broker.js';
import { assertTopology, WAREHOUSE_QUEUE } from './messaging/topology.js';
import { consumeOrderPlaced, PREFETCH } from './messaging/order-placed.consumer.js';

async function main() {
  await AppDataSource.initialize();
  const conn = await connectBroker();
  // no reconnect logic here on purpose: exit and let the orchestrator restart
  // us. Unacked messages go back to the queue either way.
  conn.on('close', () => {
    console.error('[consumer] broker connection closed, exiting');
    process.exit(1);
  });

  const ch = await conn.createChannel();
  await assertTopology(ch);
  await consumeOrderPlaced(ch, AppDataSource, {
    onEffect: (e, applied) =>
      console.log(`${e.eventId} ${applied ? 'fulfillment created' : 'already fulfilled, skipped'}`),
    onReject: (_msg, requeue, err) =>
      console.error(`rejected (requeue=${requeue}): ${err.message}`),
  });
  console.log(`[consumer] listening on ${WAREHOUSE_QUEUE}, prefetch=${PREFETCH}`);

  process.on('SIGTERM', async () => {
    await conn.close();
    await AppDataSource.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[consumer] failed to start:', err.message);
  process.exit(1);
});
