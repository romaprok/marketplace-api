import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { User } from '../../src/entities/User.js';
import { Product } from '../../src/entities/Product.js';
import { Order } from '../../src/entities/Order.js';
import { OrderItem } from '../../src/entities/OrderItem.js';
import { Task } from '../../src/entities/Task.js';
import { InitSchema1789313665216 } from '../../src/migrations/1789313665216-InitSchema.js';
import { AddStockBalanceTasks1789315001441 } from '../../src/migrations/1789315001441-AddStockBalanceTasks.js';

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  dataSource: DataSource;
  /** Deletes every row without dropping the schema — the isolation strategy
   * for this suite, see test/integration/README section in the project README. */
  truncateAll(): Promise<void>;
  stop(): Promise<void>;
}

// A dedicated DataSource, not src/data-source.ts's exported singleton: that
// module computes its connection url from process.env.DB_URL at import time
// (see resolveConnectionUrl in src/data-source.ts), which would throw before
// the container even exists. Tests need their own, pointed at the container.
export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const dataSource = new DataSource({
    type: 'postgres',
    url: container.getConnectionUri(),
    synchronize: false,
    entities: [User, Product, Order, OrderItem, Task],
    // Explicit classes, not a glob string: TypeORM's glob loader does its
    // own dynamic import() internally, and under Jest's ESM mode (which
    // shares Node's real module cache across test files, unlike its
    // sandboxed CJS require) a second test file's DataSource.initialize()
    // can end up resolving a stray import tied to the FIRST file's already
    // torn-down environment ("import a file after the Jest environment has
    // been torn down"). Importing the classes ourselves avoids the glob scan.
    migrations: [InitSchema1789313665216, AddStockBalanceTasks1789315001441],
  });
  await dataSource.initialize();
  await dataSource.runMigrations();

  return {
    container,
    dataSource,
    async truncateAll() {
      await dataSource.query(
        'TRUNCATE TABLE order_items, tasks, orders, products, users RESTART IDENTITY CASCADE',
      );
    },
    async stop() {
      await dataSource.destroy();
      await container.stop();
    },
  };
}
