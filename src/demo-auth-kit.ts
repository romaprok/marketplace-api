import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { hashPassword } from './auth/passwords.js';
import type { Role } from './auth/tokens.js';
import type { Pod } from './demo-redis-kit.js';

export interface DemoUser {
  id: string;
  email: string;
  password: string;
}

// @demo.test, so prepareDb() removes it (and its tokens, orders, products) next run
export async function createUser(ds: DataSource, role: Role, balance = 0): Promise<DemoUser> {
  const email = `${role}-${randomUUID()}@demo.test`;
  const password = randomUUID();
  const [row] = await ds.query(
    `INSERT INTO users (email, display_name, role, password_hash, balance) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [email, `Demo ${role}`, role, await hashPassword(password), balance],
  );
  return { id: row.id, email, password };
}

export interface Call {
  status: number;
  // the demos read a field or two out of whatever came back
  body: Record<string, any>;
}

export async function call(
  pod: Pod,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Call> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(pod.url + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

export async function login(pod: Pod, user: DemoUser) {
  const res = await call(pod, 'POST', '/v1/auth/login', { body: { email: user.email, password: user.password } });
  return { status: res.status, access: res.body.access_token as string, refresh: res.body.refresh_token as string };
}

export async function refresh(pod: Pod, refreshToken: string) {
  const res = await call(pod, 'POST', '/v1/auth/refresh', { body: { refresh_token: refreshToken } });
  return { status: res.status, access: res.body.access_token as string, refresh: res.body.refresh_token as string };
}

// Same token, payload edited, old signature kept. A server that decodes
// instead of verifying would take this for an admin.
export function tamper(access: string, patch: Record<string, unknown>): string {
  const [header, payload, signature] = access.split('.');
  const claims = { ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), ...patch };
  return [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');
}
