// npm run demo:queue — a job that fails twice and then succeeds, two adds
// with one jobId that make one job, and a scheduler upserted twice that
// exists once and keeps firing. Stop `npm run worker` first: it would take
// some of these jobs.
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { finish, prepareDb, report, sleep, waitFor } from './demo-kit.js';
import { createJobsQueue, enqueueReceipt, JOBS_QUEUE, OUTBOX_CLEANUP, processJob, scheduleOutboxCleanup, SEND_RECEIPT } from './queue/jobs.js';
import { queueConnection, workerConnection } from './redis/clients.js';

const SCHEDULE_EVERY_MS = 1000;
const OBSERVE_MS = 3500;
const FAIL_TIMES = 2;

async function main() {
  const ds = await prepareDb();
  const conn = queueConnection();
  const queue = createJobsQueue(conn);
  await queue.waitUntilReady();
  // jobs, schedulers and dedup ids from earlier runs
  await queue.obliterate({ force: true });

  const [, policy] = (await conn.config('GET', 'maxmemory-policy')) as [string, string];

  // 1. dedup: the same order enqueued twice before any worker runs
  const orderId = randomUUID();
  let added = 0;
  await enqueueReceipt(queue, orderId);
  added++;
  await enqueueReceipt(queue, orderId);
  added++;
  const queued = await queue.count();

  // 2. scheduler: upserted twice (two worker restarts), must exist once
  await scheduleOutboxCleanup(queue, SCHEDULE_EVERY_MS);
  await scheduleOutboxCleanup(queue, SCHEDULE_EVERY_MS);
  const schedulers = (await queue.getJobSchedulers()).length;

  // 3. a mail provider that answers 503 twice
  let attempts = 0;
  const attemptAt: number[] = [];
  const sendReceipt = async () => {
    attempts++;
    attemptAt.push(Date.now());
    if (attempts <= FAIL_TIMES) throw new Error('mail provider answered 503');
  };

  let completed = 0;
  let scheduledRuns = 0;
  const startedAt = Date.now();
  const workerConn = workerConnection();
  const worker = new Worker(JOBS_QUEUE, processJob({ ds, sendReceipt }), { connection: workerConn });
  worker.on('completed', (job) => {
    if (job.name === SEND_RECEIPT) completed++;
    if (job.name === OUTBOX_CLEANUP) scheduledRuns++;
  });

  await waitFor(() => completed === 1, 20_000);
  await sleep(Math.max(0, OBSERVE_MS - (Date.now() - startedAt)));

  // 4. the job is completed but kept (removeOnComplete by age), so the same
  // jobId still dedups
  await enqueueReceipt(queue, orderId);
  const dedupAfterComplete = (await queue.getJobState(`receipt-${orderId}`)) === 'completed' ? 1 : 0;

  await worker.close();
  await queue.removeJobScheduler(OUTBOX_CLEANUP);
  await queue.close();
  // close() leaves a connection it was handed open, and open sockets keep the process alive
  conn.disconnect();
  workerConn.disconnect();
  await ds.destroy();

  report({
    'queue-noeviction': policy === 'noeviction' ? 1 : 0,
    attempts,
    'retry-gap-1-ms': attemptAt[1]! - attemptAt[0]!,
    'retry-gap-2-ms': attemptAt[2]! - attemptAt[1]!,
    completed,
    added,
    queued,
    'dedup-after-complete': dedupAfterComplete,
    schedulers,
    'scheduled-runs': scheduledRuns,
  });

  finish(
    policy === 'noeviction' && attempts >= 3 && completed === 1 && added === 2 && queued === 1 &&
      dedupAfterComplete === 1 && schedulers >= 1 && scheduledRuns >= 2,
    'retried until done, one job per jobId, one scheduler that fires',
  );
}

main().catch((err) => {
  console.error('demo:queue failed:', err);
  process.exit(1);
});
