// npm run demo:metrics (hw-29): RED counts what really happened, and a label
// takes a bounded set of values. Deltas come from two scrapes of the pod's
// own /metrics, so nothing here waits for Prometheus. Prometheus is checked
// at the end, on the dashboard's own queries, as a bonus line.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { call } from './demo-auth-kit.js';
import { finish, prepareDb, report, sleep } from './demo-kit.js';
import {
  checkout,
  FAIL_KEY_PREFIX,
  openShop,
  requireEnv,
  scrape,
  startTracedPod,
  sum,
  type Sample,
} from './demo-obs-kit.js';

// Fixed, because Prometheus scrapes it (observability/prometheus.yml)
const POD_PORT = '22910';
const SENT_OK = 50;
const SENT_FAIL = 10;
const DISTINCT_IDS = 100;
const CONCURRENCY = 10;
// The API limits each user to 20 requests per 10 s; spread over twelve
// buyers nobody gets near it, and a 429 would only blur the counts.
const BUYERS = 12;
const CHECKOUT = '/v1/checkout';
const ORDER_BY_ID = '/v1/orders/:orderId';
const DASHBOARD = 'observability/grafana/dashboards/marketplace-red.json';

// n jobs, at most `limit` in flight
async function pool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]!();
      }
    }),
  );
  return results;
}

const seriesOf = (samples: Sample[]) => samples.filter((s) => s.name === 'http_requests_total').length;
const ofRoute = (route: string) => (l: Record<string, string>) => l.route === route;

async function promQuery(baseUrl: string, query: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
  const body = (await res.json()) as { data?: { result?: Array<{ value: [number, string] }> } };
  return (body.data?.result ?? []).map((r) => Number(r.value[1])).filter((v) => Number.isFinite(v));
}

// polls until the query returns `expected`, for up to 20 s (four scrapes)
async function promUntil(baseUrl: string, query: string, expected: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const [seen] = await promQuery(baseUrl, query);
    if (seen === expected) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  requireEnv('OTEL_EXPORTER_OTLP_ENDPOINT');
  const prometheus = requireEnv('PROMETHEUS_URL');
  const ds = await prepareDb();
  const pod = await startTracedPod({ DEMO_POD_PORT: POD_PORT });
  try {
    const shop = await openShop(ds, pod, BUYERS);
    const buyer = (i: number) => shop.buyers[i % BUYERS]!;

    // Warm up every series the demo touches, 201 and 500 on checkout and
    // 404 on an order, so they exist before series-before. And let
    // Prometheus see them once: a series that is born already at 10 has no
    // point before it, and rate() shows its whole jump as zero.
    await checkout(pod, buyer(0).token, shop.productId);
    await checkout(pod, buyer(0).token, shop.productId, { key: `${FAIL_KEY_PREFIX}${randomUUID()}` });
    await call(pod, 'GET', `/v1/orders/${randomUUID()}`, { token: buyer(0).token });
    const instance = `host.docker.internal:${POD_PORT}`;
    const seenBy = (total: number) => promUntil(prometheus, `sum(http_requests_total{instance="${instance}",route="${CHECKOUT}"})`, total);
    const sawWarmup = await seenBy(2);

    // 1. Cardinality: a hundred different order ids, a hundred 404s.
    // route is the template, so not one new series may appear.
    const beforeIds = await scrape(pod);
    const idStatuses = await pool(
      Array.from({ length: DISTINCT_IDS }, (_, i) => async () =>
        (await call(pod, 'GET', `/v1/orders/${randomUUID()}`, { token: buyer(i).token })).status,
      ),
      CONCURRENCY,
    );
    const afterIds = await scrape(pod);

    // 2. RED on checkout: 50 that go through and 10 that fail with a 500
    // right before COMMIT, mixed and in parallel, all on one product, so
    // they also queue on its row lock. That queue is the slow end of the
    // histogram.
    const plan = [...Array(SENT_OK).fill('ok'), ...Array(SENT_FAIL).fill('fail')].sort(() => Math.random() - 0.5);
    const results = await pool(
      plan.map((kind, i) => () =>
        checkout(pod, buyer(i).token, shop.productId, kind === 'fail' ? { key: `${FAIL_KEY_PREFIX}${randomUUID()}` } : {}),
      ),
      CONCURRENCY,
    );
    const afterRed = await scrape(pod);

    const sentOk = results.filter((r) => r.status === 201).length;
    const sentFail = results.filter((r) => r.status >= 500).length;
    const counterDelta = sum(afterRed, 'http_requests_total', ofRoute(CHECKOUT)) - sum(afterIds, 'http_requests_total', ofRoute(CHECKOUT));
    const errorsDelta =
      sum(afterRed, 'http_requests_total', (l) => l.route === CHECKOUT && l.status!.startsWith('5')) -
      sum(afterIds, 'http_requests_total', (l) => l.route === CHECKOUT && l.status!.startsWith('5'));

    // above-top-bucket: requests slower than the largest finite bucket.
    // They exist only in +Inf, and no quantile can say anything about them.
    const bounds = afterRed
      .filter((s) => s.name === 'http_request_duration_seconds_bucket' && s.labels.le !== '+Inf')
      .map((s) => Number(s.labels.le));
    const top = Math.max(...bounds);
    const count = sum(afterRed, 'http_request_duration_seconds_count', ofRoute(CHECKOUT));
    const inTop = sum(afterRed, 'http_request_duration_seconds_bucket', (l) => l.route === CHECKOUT && Number(l.le) === top);

    // 3. Bonus: did Prometheus scrape the same numbers, and do the three
    // dashboard panels have something to draw? Not part of the verdict:
    // it depends on Prometheus reaching the host, not on the API.
    const inSync = await seenBy(sum(afterRed, 'http_requests_total', ofRoute(CHECKOUT)));
    const panels = JSON.parse(readFileSync(DASHBOARD, 'utf8')).panels as Array<{ targets: Array<{ expr: string }> }>;
    let panelsWithData = 0;
    for (let i = 0; inSync && i < 30 && panelsWithData < panels.length; i++) {
      if (i > 0) await sleep(500);
      panelsWithData = 0;
      for (const panel of panels) {
        const values = await Promise.all(panel.targets.map((t) => promQuery(prometheus, t.expr)));
        if (values.some((v) => v.length > 0)) panelsWithData++;
      }
    }
    const [p95] = await promQuery(
      prometheus,
      `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{instance="${instance}",route="${CHECKOUT}"}[1m])))`,
    );

    const values = {
      'sent-ok': sentOk,
      'sent-fail': sentFail,
      'counter-delta': counterDelta,
      'errors-delta': errorsDelta,
      'top-bucket-seconds': top,
      'above-top-bucket': count - inTop,
      'slowest-checkout-ms': Math.round(Math.max(...results.map((r) => r.ms))),
      // what the client measured, to hold against the histogram's estimate
      'client-p95-ms': Math.round(results.map((r) => r.ms).sort((a, b) => a - b)[Math.ceil(results.length * 0.95) - 1]!),
      'distinct-ids': DISTINCT_IDS,
      'id-statuses-404': idStatuses.filter((s) => s === 404).length,
      'series-before': seriesOf(beforeIds),
      'series-after': seriesOf(afterIds),
      'prometheus-saw-warmup': sawWarmup ? 1 : 0,
      'prometheus-in-sync': inSync ? 1 : 0,
      'dashboard-panels-with-data': panelsWithData,
      'prometheus-p95-ms': p95 === undefined ? -1 : Math.round(p95 * 1000),
    };
    report(values);

    finish(
      sentOk + sentFail >= 50 &&
        counterDelta === sentOk + sentFail &&
        errorsDelta === sentFail &&
        values['above-top-bucket'] === 0 &&
        values['series-after'] === values['series-before'],
      'the counter moved by exactly what was sent, errors by exactly the 5xx, nothing above the top bucket, no new series',
    );
  } finally {
    await pod.close();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:metrics failed:', err);
  process.exit(1);
});
