// The Postgres API, npm start (bare) or npm run start:vault (through the vault).
// The hw-09 in-memory API moved to npm run start:inmemory.
// apiEnv goes first: it validates the environment before anything below
// touches the database, so a start without the vault names what's missing.
import { apiEnv } from './config/api-env.js';
import 'reflect-metadata';
import { fingerprint, keysFrom } from './auth/tokens.js';
import { AppDataSource } from './data-source.js';
import { createApi } from './http/api.js';
import { connectCache, connectSessionStore } from './redis/clients.js';

async function main() {
  const keys = keysFrom(apiEnv);
  await AppDataSource.initialize();
  const app = createApi({
    ds: AppDataSource,
    cache: await connectCache(),
    sessionStore: await connectSessionStore(),
    keys,
    pepper: apiEnv.REFRESH_TOKEN_PEPPER,
  });
  app.listen(apiEnv.ORDERS_API_PORT, () => {
    // the fingerprint, never the key: enough to tell dev from prod in a log
    console.log(`[api] signing kid=${keys.kid} ${fingerprint(apiEnv.JWT_PUBLIC_KEY)}`);
    console.log(`[api] listening on http://localhost:${apiEnv.ORDERS_API_PORT}/v1`);
  });
}

main().catch((err) => {
  console.error('[api] failed to start:', err.message);
  process.exit(1);
});
