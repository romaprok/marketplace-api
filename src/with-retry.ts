import type { DataSource, EntityManager } from 'typeorm';
import type { IsolationLevel } from 'typeorm/driver/types/IsolationLevel.js';

// Postgres error codes for the two situations a transaction can legitimately
// retry from scratch: 40001 (serialization_failure, under SERIALIZABLE or a
// REPEATABLE READ write-write conflict) and 40P01 (deadlock_detected). Any
// other error is a real bug or a real business rejection — rethrown as-is,
// never retried.
const RETRYABLE_CODES = new Set(['40001', '40P01']);

export interface RetryOptions {
  isolationLevel?: IsolationLevel;
  maxAttempts?: number;
  onRetry?: (attempt: number, code: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries the *whole* transaction, including its reads — a retry that only
// redid the write would reuse a value read under the failed attempt's now-
// stale snapshot, which is the same lost-update bug this exists to prevent.
export async function withRetry<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { isolationLevel = 'REPEATABLE READ', maxAttempts = 5, onRetry } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await dataSource.transaction(isolationLevel, fn);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt >= maxAttempts) {
        throw err;
      }
      onRetry?.(attempt, code);
      const backoffMs = 2 ** attempt * 15 + Math.random() * 20;
      await sleep(backoffMs);
    }
  }
}
