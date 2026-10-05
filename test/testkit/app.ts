import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export interface TestApp {
  // src/app.js is plain JS, there are no types to import
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any;
  stop(): Promise<void>;
}

// The real app (src/app.js) wired to a throwaway Postgres. Tests and the
// provider verification don't need a .env or the vault: the database comes
// from the container at runtime.
export async function startTestApp(): Promise<TestApp> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const passwordFile = path.join(mkdtempSync(path.join(tmpdir(), 'marketplace-test-')), 'db_password');
  writeFileSync(passwordFile, container.getPassword());
  // DB_URL never carries a password (src/db/pool.js); the container's password
  // goes through DB_PASSWORD_FILE, the same contract as dev and prod
  process.env.DB_URL = `postgres://${container.getUsername()}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  process.env.DB_PASSWORD_FILE = passwordFile;

  // Imported only now: config.service.js parses process.env at module load,
  // and db/pool.js builds its pool then too. Resolved from cwd instead of
  // '../../src/app.js' because tsc doesn't touch these plain JS files, and
  // the real app.js keeps its relative path to openapi.yaml valid.
  const { createApp } = await import(pathToFileURL(path.resolve(process.cwd(), 'src/app.js')).href);
  const { pool } = await import(pathToFileURL(path.resolve(process.cwd(), 'src/db/pool.js')).href);

  return {
    app: createApp(),
    async stop() {
      // an unclosed pool keeps jest (or the verify script) from exiting
      await pool.end();
      await container.stop();
    },
  };
}
