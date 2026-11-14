// Shared by demo:logs, demo:metrics and demo:trace (hw-29).
import { randomBytes, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { call, createUser, login, type DemoUser } from './demo-auth-kit.js';
import { demoRateLimitName, startPod, type Pod } from './demo-redis-kit.js';

// An Idempotency-Key with this prefix makes the demo pod fail the checkout
// right before COMMIT (src/demo-pod.ts)
export const FAIL_KEY_PREFIX = 'fail-';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required: it comes from the vault via scripts/with-secrets.sh (README, Observability)`);
    process.exit(1);
  }
  return value;
}

// W3C Trace Context: 00-<32 hex trace-id>-<16 hex parent-id>-<flags>, 01 = sampled.
// The parent is a span of ours that never gets exported: the demo plays a
// client that only passes its context on.
export function traceparent() {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return { traceId, parentId, header: `00-${traceId}-${parentId}-01` };
}

// A pod with tracing on and its own limiter namespace, so three runs in a
// row don't eat each other's budget.
export function startTracedPod(env: Record<string, string> = {}): Promise<Pod> {
  return startPod({ DEMO_RATE_LIMIT_NAME: demoRateLimitName(), ...env }, { traced: true });
}

export type LogLine = Record<string, any>;

// Everything the pod printed, split into JSON objects and whatever isn't one.
export function parseLog(output: string): { lines: LogLine[]; nonJson: string[] } {
  const lines: LogLine[] = [];
  const nonJson: string[] = [];
  for (const raw of output.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) lines.push(value);
      else nonJson.push(raw);
    } catch {
      nonJson.push(raw);
    }
  }
  return { lines, nonJson };
}

export interface Shop {
  productId: string;
  buyers: Array<DemoUser & { token: string }>;
}

// A seller with one product and n buyers with money, logged in. Everything
// is @demo.test, so prepareDb() clears it on the next run.
export async function openShop(ds: DataSource, pod: Pod, buyers: number, stock = 1000): Promise<Shop> {
  const seller = await createUser(ds, 'seller');
  const [{ id: productId }] = await ds.query(
    `INSERT INTO products (name, price, currency, seller_id, stock) VALUES ('Observed product', 1, 'UAH', $1, $2) RETURNING id`,
    [seller.id, stock],
  );
  const users = await Promise.all(Array.from({ length: buyers }, () => createUser(ds, 'buyer', 100_000)));
  const logged = [];
  for (const user of users) {
    const res = await login(pod, user);
    if (res.status !== 200) throw new Error(`login failed with ${res.status}`);
    logged.push({ ...user, token: res.access });
  }
  return { productId, buyers: logged };
}

export async function checkout(
  pod: Pod,
  token: string,
  productId: string,
  { key = randomUUID(), traceparent }: { key?: string; traceparent?: string } = {},
) {
  const headers: Record<string, string> = { 'idempotency-key': key };
  if (traceparent) headers.traceparent = traceparent;
  const started = performance.now();
  const res = await call(pod, 'POST', '/v1/checkout', { token, headers, body: { product_id: productId, quantity: 1 } });
  return { status: res.status, ms: performance.now() - started, key };
}

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

// The Prometheus text format, one sample per line: name{a="b",...} value
export async function scrape(pod: Pod): Promise<Sample[]> {
  const text = await (await fetch(`${pod.url}/metrics`)).text();
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!;
    samples.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return samples;
}

export const sum = (samples: Sample[], name: string, match: (labels: Record<string, string>) => boolean = () => true) =>
  samples.filter((s) => s.name === name && match(s.labels)).reduce((acc, s) => acc + s.value, 0);
