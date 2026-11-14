// npm run demo:trace (hw-29): one key opens both doors. A checkout that
// fails with a 500 comes in with our traceparent; then the trace is read
// back from the trace backend and the lines from the pod's stdout, and the
// trace ids are compared: header = spans = log.
import { randomUUID } from 'node:crypto';
import { finish, prepareDb, report, sleep, waitFor } from './demo-kit.js';
import {
  checkout,
  FAIL_KEY_PREFIX,
  openShop,
  parseLog,
  requireEnv,
  startTracedPod,
  traceparent,
} from './demo-obs-kit.js';

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: string;
  status: string;
}

// OTLP JSON carries ids as base64 bytes; logs and headers carry hex.
const hex = (id: string | undefined) =>
  !id ? '' : /^[0-9a-f]+$/.test(id) && (id.length === 32 || id.length === 16) ? id : Buffer.from(id, 'base64').toString('hex');

// Tempo answers /api/traces/<id> with OTLP JSON: batches (or resourceSpans)
// of scopeSpans of spans. 404 until the first batch has arrived.
async function fetchTrace(baseUrl: string, traceId: string): Promise<Span[]> {
  const res = await fetch(`${baseUrl}/api/traces/${traceId}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`trace backend answered ${res.status}`);
  const body = (await res.json()) as Record<string, any>;
  const spans: Span[] = [];
  for (const batch of body.batches ?? body.resourceSpans ?? body.trace?.resourceSpans ?? []) {
    for (const scope of batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []) {
      for (const s of scope.spans ?? []) {
        spans.push({
          traceId: hex(s.traceId),
          spanId: hex(s.spanId),
          parentSpanId: hex(s.parentSpanId),
          name: s.name,
          kind: String(s.kind),
          status: String(s.status?.code ?? ''),
        });
      }
    }
  }
  return spans;
}

const isServer = (s: Span) => s.kind === 'SPAN_KIND_SERVER' || s.kind === '2';
const isError = (s: Span) => s.status === 'STATUS_CODE_ERROR' || s.status === '2';

async function main() {
  requireEnv('OTEL_EXPORTER_OTLP_ENDPOINT');
  const traceApi = requireEnv('TRACE_API_URL');
  const ds = await prepareDb();
  // spans leave the pod every 200 ms instead of every 5 s
  const pod = await startTracedPod({ OTEL_BSP_SCHEDULE_DELAY: '200' });
  try {
    const shop = await openShop(ds, pod, 1);
    const tp = traceparent();
    // A 500 on purpose: OTel marks a span ERROR for 5xx and leaves 4xx Unset
    const res = await checkout(pod, shop.buyers[0]!.token, shop.productId, {
      traceparent: tp.header,
      key: `${FAIL_KEY_PREFIX}${randomUUID()}`,
    });

    // The batch exporter is not instant and the backend ingests in pieces:
    // poll until the server span is there and the count stops growing.
    let spans: Span[] = [];
    const started = Date.now();
    await waitFor(async () => {
      const now = await fetchTrace(traceApi, tp.traceId);
      const settled = now.length > 0 && now.length === spans.length && now.some(isServer);
      spans = now;
      if (!settled) await sleep(300);
      return settled;
    }, 20_000);
    const waitedMs = Date.now() - started;

    const ids = new Set(spans.map((s) => s.spanId));
    const server = spans.find(isServer);
    // An orphan points at a parent the trace doesn't have. The one parent
    // that is legitimately missing is ours: the span id from the header.
    const orphans = spans.filter((s) => s.parentSpanId && !ids.has(s.parentSpanId) && s.parentSpanId !== tp.parentId);

    // The pod's lines for this request, found by its Idempotency-Key
    const lines = parseLog(pod.log()).lines.filter((l) => l.idempotency_key === res.key);
    const logTraceIds = new Set(lines.map((l) => l.trace_id ?? 'none'));
    const spanTraceIds = new Set(spans.map((s) => s.traceId));

    const values = {
      'http-status': res.status,
      spans: spans.length,
      'orphan-spans': orphans.length,
      'server-parent-matches-header': server?.parentSpanId === tp.parentId ? 1 : 0,
      'trace-matches-header': spanTraceIds.size === 1 && spanTraceIds.has(tp.traceId) ? 1 : 0,
      'log-lines': lines.length,
      'trace-matches-log': logTraceIds.size === 1 && spanTraceIds.size === 1 && logTraceIds.has([...spanTraceIds][0]!) ? 1 : 0,
      'error-logged': lines.some((l) => l.level === 'error') ? 1 : 0,
      'span-status-error': server && isError(server) ? 1 : 0,
      'trace-wait-ms': waitedMs,
    };
    report(values);
    if (server) console.log(`# server span: ${server.name}`);

    finish(
      res.status === 500 &&
        values.spans >= 2 &&
        values['orphan-spans'] === 0 &&
        values['trace-matches-header'] === 1 &&
        values['trace-matches-log'] === 1 &&
        values['span-status-error'] === 1,
      'the trace id in the header, in the spans and in the log line is one and the same, and the 5xx span is ERROR',
    );
  } finally {
    await pod.close();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:trace failed:', err);
  process.exit(1);
});
