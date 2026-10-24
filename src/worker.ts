// The BullMQ worker as a long-running process:
//   npm run build && npm run worker
import 'reflect-metadata';
import { Worker } from 'bullmq';
import { AppDataSource } from './data-source.js';
import { createJobsQueue, JOBS_QUEUE, processJob, scheduleOutboxCleanup } from './queue/jobs.js';
import { queueConnection, workerConnection } from './redis/clients.js';

const CLEANUP_EVERY_MS = 60 * 60 * 1000;

async function main() {
  await AppDataSource.initialize();
  const conn = queueConnection();
  const queue = createJobsQueue(conn);
  await queue.waitUntilReady();
  await scheduleOutboxCleanup(queue, CLEANUP_EVERY_MS);

  const workerConn = workerConnection();
  const worker = new Worker(
    JOBS_QUEUE,
    processJob({
      ds: AppDataSource,
      // no mail provider in this project yet; the job is where it would go
      sendReceipt: async (orderId) => console.log(`[worker] receipt for order ${orderId}`),
    }),
    { connection: workerConn, concurrency: 5 },
  );
  worker.on('failed', (job, err) => console.warn(`[worker] ${job?.name} ${job?.id} attempt ${job?.attemptsMade}:`, err.message));
  console.log(`[worker] consuming ${JOBS_QUEUE}`);

  const stop = async () => {
    await worker.close();
    await queue.close();
    conn.disconnect();
    workerConn.disconnect();
    await AppDataSource.destroy();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('[worker] failed to start:', err.message);
  process.exit(1);
});
