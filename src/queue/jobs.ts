import { Queue, UnrecoverableError, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';

// The one BullMQ queue: work that has no business inside an HTTP request.
export const JOBS_QUEUE = 'jobs';
export const SEND_RECEIPT = 'send-receipt';
export const OUTBOX_CLEANUP = 'outbox-cleanup';

export const JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  // 500 ms, 1 s, 2 s, each cut by up to half at random so retries of many
  // failed jobs don't hit the mail provider in the same instant
  backoff: { type: 'exponential', delay: 500, jitter: 0.5 },
  // Not `true`: a removed job stops blocking its jobId, and dedup is gone.
  // A day is longer than any window in which the same order comes again.
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createJobsQueue(connection: Redis): Queue {
  return new Queue(JOBS_QUEUE, { connection, defaultJobOptions: JOB_OPTIONS });
}

// One receipt per order: the order id is the jobId, so a second add (a
// redelivered order.placed, a retried request) is a no-op. BullMQ doesn't
// allow ':' in custom ids.
export function enqueueReceipt(queue: Queue, orderId: string): Promise<Job> {
  return queue.add(SEND_RECEIPT, { orderId }, { jobId: `receipt-${orderId}` });
}

// upsert, not add: every worker start runs this, and add would stack one
// more scheduler per restart
export function scheduleOutboxCleanup(queue: Queue, everyMs: number) {
  return queue.upsertJobScheduler(OUTBOX_CLEANUP, { every: everyMs }, { name: OUTBOX_CLEANUP });
}

export interface JobDeps {
  ds: DataSource;
  sendReceipt(orderId: string): Promise<void>;
}

export function processJob(deps: JobDeps) {
  return async (job: Job) => {
    switch (job.name) {
      case SEND_RECEIPT:
        return deps.sendReceipt(job.data.orderId);
      case OUTBOX_CLEANUP: {
        // the cleanup hw-22's README promised: published rows older than a
        // week, in batches, so one run never holds a long lock
        const [, deleted]: [unknown, number] = await deps.ds.query(
          `DELETE FROM outbox WHERE id IN (
             SELECT id FROM outbox WHERE published_at < now() - interval '7 days' LIMIT 1000)`,
        );
        return { deleted };
      }
      default:
        // retrying won't teach the worker a new job name
        throw new UnrecoverableError(`unknown job ${job.name}`);
    }
  };
}
