// The outbox relay as a long-running process:
//   npm run build && npm run relay
import 'reflect-metadata';
import { AppDataSource } from './data-source.js';
import { connectBroker } from './messaging/broker.js';
import { relayOnce, RELAY_BATCH } from './messaging/outbox-relay.js';

const POLL_MS = 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await AppDataSource.initialize();
  const conn = await connectBroker();
  conn.on('close', () => {
    console.error('[relay] broker connection closed, exiting');
    process.exit(1);
  });
  const ch = await conn.createConfirmChannel();
  console.log(`[relay] polling the outbox every ${POLL_MS} ms, batch ${RELAY_BATCH}`);

  for (;;) {
    try {
      const n = await relayOnce(AppDataSource, ch);
      if (n > 0) console.log(`[relay] published ${n}`);
      // a full batch means more rows are waiting, go again right away
      if (n === RELAY_BATCH) continue;
    } catch (err) {
      console.error('[relay] pass failed, retrying:', (err as Error).message);
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error('[relay] failed to start:', err.message);
  process.exit(1);
});
