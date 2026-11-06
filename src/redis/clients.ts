import { Redis } from 'ioredis';
import { loggerFor } from '../telemetry/logger.js';

const log = loggerFor('redis');

function url(name: 'REDIS_URL' | 'REDIS_QUEUE_URL'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required: it comes from the vault via scripts/with-secrets.sh (docs/configuration.md)`);
  }
  return value;
}

// For anything on the request path (cache, rate limit, sessions): fail fast.
// A dead or slow Redis must turn into an error the caller can handle within
// half a second, not a request that hangs while ioredis retries.
async function requestPathClient(name: 'REDIS_URL' | 'REDIS_QUEUE_URL'): Promise<Redis> {
  const client = new Redis(url(name), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
  });
  // without a listener every reconnect attempt is an unhandled 'error' event
  client.on('error', (err) => log.warn({ client: name, err: err.message }, 'redis error'));
  await client.connect();
  return client;
}

// cache instance: allkeys-lru
export const connectCache = () => requestPathClient('REDIS_URL');

// queue instance: noeviction + AOF. Sessions live here too, see README.
export const connectSessionStore = () => requestPathClient('REDIS_QUEUE_URL');

// Scripts and demos that write in bulk: no request timeout. A 2 MB pipeline
// into an instance that is busy evicting can take longer than 500 ms, and
// that is fine off the request path.
export function cacheBulkConnection(): Redis {
  const client = new Redis(url('REDIS_URL'));
  client.on('error', (err) => log.warn({ client: 'REDIS_URL bulk', err: err.message }, 'redis error'));
  return client;
}

// BullMQ Queue (producer side): failing fast on add() is right, the caller decides.
export function queueConnection(): Redis {
  return new Redis(url('REDIS_QUEUE_URL'), { enableOfflineQueue: false });
}

// BullMQ Worker: maxRetriesPerRequest must be null, otherwise ioredis throws
// on a dropped connection and the worker breaks instead of waiting for Redis.
export function workerConnection(): Redis {
  return new Redis(url('REDIS_QUEUE_URL'), { maxRetriesPerRequest: null });
}
