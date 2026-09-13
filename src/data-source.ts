import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { Order } from './entities/Order.js';
import { OrderItem } from './entities/OrderItem.js';
import { Product } from './entities/Product.js';
import { User } from './entities/User.js';

// Same shape as hw-11's config layer: DB_URL never carries a password,
// the password lives in a file (DB_PASSWORD_FILE) so it can be rotated
// without touching env or restarting the process. No host/password is
// hardcoded here, and no new env file is introduced — both come from
// process.env, which scripts/with-secrets.sh populates (see README).
function resolveConnectionUrl(): string {
  const base = process.env.DB_URL;
  if (!base) {
    throw new Error('DB_URL is required — see README Configuration / Grading section');
  }
  const passwordFile = process.env.DB_PASSWORD_FILE;
  if (!passwordFile) return base;
  const password = readFileSync(passwordFile, 'utf8').trim();
  const url = new URL(base);
  url.password = password;
  return url.toString();
}

// Exported so demo/report scripts can build their own DataSource with a
// custom logger (query counting, etc.) without duplicating the DB_URL /
// DB_PASSWORD_FILE resolution above.
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: resolveConnectionUrl(),
  synchronize: false,
  logging: false,
  entities: [User, Product, Order, OrderItem],
  migrations: ['dist/migrations/*.js'],
};

export const AppDataSource = new DataSource(dataSourceOptions);
