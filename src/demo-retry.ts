import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source.js';
import { User } from './entities/User.js';
import { withRetry } from './with-retry.js';

const BUYER_ID = '90000000-0000-4000-8000-000000000001';
const INITIAL_BALANCE = 100;
const TOPUPS = [50, 30];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let retryCount = 0;

// Classic read-modify-write under REPEATABLE READ: both transactions read
// the same snapshot of `balance`, both compute a new value from it, and
// whichever commits second gets 40001 — Postgres detects that the row it's
// about to write has been changed since its snapshot was taken. The sleep
// between read and write isn't part of the fix, it's what makes the
// conflict happen reliably instead of depending on scheduler luck.
async function topUp(ds: DataSource, amount: number): Promise<number> {
  return withRetry(
    ds,
    async (manager) => {
      const rows: Array<{ balance: string }> = await manager.query(
        'SELECT balance FROM users WHERE id = $1',
        [BUYER_ID],
      );
      const current = Number(rows[0]!.balance);
      await sleep(150);
      const next = Math.round((current + amount) * 100) / 100;
      await manager.query('UPDATE users SET balance = $1 WHERE id = $2', [next, BUYER_ID]);
      return next;
    },
    {
      onRetry: (attempt, code) => {
        retryCount += 1;
        console.log(`retry #${attempt} for +${amount}: caught ${code}, backing off and retrying whole transaction`);
      },
    },
  );
}

async function main() {
  const ds = new DataSource(dataSourceOptions);
  await ds.initialize();

  const userRepo = ds.getRepository(User);
  await userRepo.save(
    userRepo.create({ id: BUYER_ID, email: 'retry-demo@example.com', displayName: 'Retry Demo Buyer', balance: INITIAL_BALANCE }),
  );

  await Promise.all(TOPUPS.map((amount) => topUp(ds, amount)));

  const final = await userRepo.findOneByOrFail({ id: BUYER_ID });
  const expected = Math.round((INITIAL_BALANCE + TOPUPS.reduce((a, b) => a + b, 0)) * 100) / 100;

  console.log(`Initial balance: ${INITIAL_BALANCE}`);
  console.log(`Top-ups: ${TOPUPS.join(' + ')}`);
  console.log(`Retries caught (40001/40P01): ${retryCount}`);
  console.log(`Final balance: ${final.balance} (expected ${expected})`);

  await ds.destroy();

  if (final.balance !== expected) {
    console.error(`Lost update: final balance ${final.balance} != expected ${expected}`);
    process.exit(1);
  }
  if (retryCount === 0) {
    console.error('Expected at least one retry (40001/40P01) to be caught and retried');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
