import 'reflect-metadata';
import { DataSource, type Repository } from 'typeorm';
import { dataSourceOptions } from './data-source.js';
import { Order } from './entities/Order.js';
import { Task } from './entities/Task.js';
import { User } from './entities/User.js';

const TASK_COUNT = 20;
const WORKER_COUNT = 4;
// checkout.ts also enqueues 'send_receipt' tasks (hw-14 demo:race leaves
// its own behind) — every query here filters on this type so this demo
// only ever sees the batch it created itself, not leftovers from other runs.
const TASK_TYPE = 'demo_workers_task';
// Simulates the actual work a "send receipt" task would do (an email API
// call, PDF render, whatever) — needed so the sequential-time comparison
// means anything; with instant tasks, "parallel is faster" would be lost
// in scheduling noise.
const WORK_MS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// FOR UPDATE SKIP LOCKED: any worker whose SELECT would block on a row
// another worker already has locked simply skips that row instead of
// waiting — so N workers never contend for the same task, each claim goes
// to a genuinely free row.
async function claimOne(ds: DataSource, workerId: string): Promise<string | null> {
  return ds.transaction(async (manager) => {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT id FROM tasks WHERE status = 'pending' AND type = $1 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [TASK_TYPE],
    );
    if (rows.length === 0) return null;
    const id = rows[0]!.id;
    await sleep(WORK_MS); // the "work", done while still holding the row lock
    await manager.query(
      `UPDATE tasks SET status = 'done', processed = processed + 1, processed_by = $1, processed_at = now() WHERE id = $2`,
      [workerId, id],
    );
    return id;
  });
}

async function worker(ds: DataSource, workerId: string, taskRepo: Repository<Task>): Promise<number> {
  let claimedCount = 0;
  for (;;) {
    const claimed = await claimOne(ds, workerId);
    if (claimed) {
      claimedCount += 1;
      continue;
    }
    // An empty SKIP LOCKED result means "nothing free right now", not
    // necessarily "queue is empty" — another worker could be mid-transaction
    // holding the last pending row. Recheck the real count before quitting.
    const remaining = await taskRepo.count({ where: { status: 'pending', type: TASK_TYPE } });
    if (remaining === 0) break;
  }
  return claimedCount;
}

async function main() {
  const ds = new DataSource({ ...dataSourceOptions, extra: { max: 20 } });
  await ds.initialize();

  const userRepo = ds.getRepository(User);
  const orderRepo = ds.getRepository(Order);
  const taskRepo = ds.getRepository(Task);

  // Clear this demo's own tasks from any previous run so the printed
  // counts always describe exactly this run's batch, not an accumulation.
  await ds.query('DELETE FROM tasks WHERE type = $1', [TASK_TYPE]);

  const buyer = await userRepo.save(userRepo.create({ email: `workers-buyer-${Date.now()}@example.com`, displayName: 'Workers Demo Buyer', balance: 0 }));

  // Fresh orders + tasks every run (random ids) — this demo doesn't need to
  // be idempotent like seed.ts, just self-contained.
  for (let i = 0; i < TASK_COUNT; i++) {
    const order = await orderRepo.save(
      orderRepo.create({ buyer, status: 'paid', total: 1, currency: 'UAH' }),
    );
    await taskRepo.save(taskRepo.create({ type: TASK_TYPE, order, status: 'pending' }));
  }

  // Baseline: how long one task takes end to end (claim tx + work), to
  // compare against the parallel wall-clock time below.
  const singleTaskMs = WORK_MS + 5; // small fixed overhead for the claim/update queries

  const stats = new Map<string, number>();
  const start = Date.now();
  const workerIds = Array.from({ length: WORKER_COUNT }, (_, i) => `worker-${i + 1}`);
  const perWorkerCounts = await Promise.all(workerIds.map((id) => worker(ds, id, taskRepo)));
  const elapsedMs = Date.now() - start;
  workerIds.forEach((id, i) => stats.set(id, perWorkerCounts[i]!));

  const doneTasks = await taskRepo.find({ where: { type: TASK_TYPE } });
  const processedTwice = doneTasks.filter((t) => t.processed !== 1).length;
  const sequentialEstimateMs = TASK_COUNT * singleTaskMs;

  console.log(`Tasks: ${TASK_COUNT}, workers: ${WORKER_COUNT}`);
  console.log('Distribution:', Object.fromEntries(stats));
  console.log(`Processed exactly once: ${doneTasks.filter((t) => t.processed === 1).length}/${TASK_COUNT}`);
  console.log(`Processed twice or more (should be 0): ${processedTwice}`);
  console.log(`Parallel wall-clock time: ${elapsedMs}ms`);
  console.log(`Sequential estimate (${TASK_COUNT} x ~${singleTaskMs}ms): ${sequentialEstimateMs}ms`);

  await ds.destroy();

  if (processedTwice !== 0) {
    console.error('A task was processed more than once — SKIP LOCKED invariant violated');
    process.exit(1);
  }
  if (elapsedMs >= sequentialEstimateMs) {
    console.error('Parallel run was not faster than the sequential estimate');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
