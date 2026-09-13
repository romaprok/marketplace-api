import type { Logger, QueryRunner } from 'typeorm';

// Counts every SQL statement TypeORM actually sends to Postgres — the only
// reliable way to see N+1 (it's invisible in the TS code itself, only in
// how many round-trips it produces). Modeled on the lecture's
// QueryCountLogger idea.
export class QueryCountLogger implements Logger {
  count = 0;

  reset(): void {
    this.count = 0;
  }

  logQuery(_query: string, _parameters?: unknown[], _queryRunner?: QueryRunner): void {
    this.count += 1;
  }

  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}
