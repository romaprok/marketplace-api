// npm run demo:logs (hw-29): the correlator lives in the context, not in
// function arguments. One checkout goes through the controller, the service
// and the repository, and every line carries the trace id that came in with
// traceparent. Eight identical checkouts in parallel don't mix. The secrets
// sent in a header and in a login body never reach a line.
// Every number here is counted from the pod's own stdout.
import { randomUUID } from 'node:crypto';
import { call } from './demo-auth-kit.js';
import { finish, prepareDb, report, waitFor } from './demo-kit.js';
import { checkout, openShop, parseLog, requireEnv, startTracedPod, traceparent, type LogLine } from './demo-obs-kit.js';

const BURST = 8;

// the access log is the last line of a request, written when the response is out
const finishedLine = (lines: LogLine[], pick: (l: LogLine) => boolean) =>
  lines.find((l) => l.layer === 'http' && l.msg === 'request finished' && pick(l));

async function main() {
  requireEnv('OTEL_EXPORTER_OTLP_ENDPOINT');
  const ds = await prepareDb();
  const pod = await startTracedPod();
  try {
    const shop = await openShop(ds, pod, 1);
    const buyer = shop.buyers[0]!;
    const lines = () => parseLog(pod.log()).lines;

    // 1. One request. Its lines are found by the Idempotency-Key, which the
    // request store puts on every line, so the trace id is checked, not used.
    const one = traceparent();
    const first = await checkout(pod, buyer.token, shop.productId, { traceparent: one.header });
    await waitFor(() => Boolean(finishedLine(lines(), (l) => l.idempotency_key === first.key)), 5000);
    const own = lines().filter((l) => l.idempotency_key === first.key);
    const ownTraceIds = new Set(own.map((l) => l.trace_id ?? 'none'));

    // 2. The burst: eight identical checkouts at once, each with its own
    // traceparent. Every line written in that window is grouped by trace_id.
    // A "current request" in a module variable would hand one request's id
    // to another's lines, and the groups would come out uneven.
    const before = lines().length;
    const sent = Array.from({ length: BURST }, () => traceparent());
    const burst = await Promise.all(
      sent.map((tp) => checkout(pod, buyer.token, shop.productId, { traceparent: tp.header })),
    );
    const burstKeys = new Set(burst.map((b) => b.key));
    await waitFor(
      () => lines().filter((l) => l.layer === 'http' && burstKeys.has(l.idempotency_key)).length === BURST,
      5000,
    );
    const groups = new Map<string, number>();
    for (const l of lines().slice(before)) groups.set(l.trace_id ?? 'none', (groups.get(l.trace_id ?? 'none') ?? 0) + 1);
    // uneven = groups whose size differs from the most common one
    const sizeCounts = new Map<number, number>();
    for (const size of groups.values()) sizeCounts.set(size, (sizeCounts.get(size) ?? 0) + 1);
    const modal = [...sizeCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    const uneven = [...groups.values()].filter((size) => size !== modal).length;
    const burstMatchesHeader = sent.every((tp) => groups.has(tp.traceId)) ? 1 : 0;

    // 3. Secrets. A made-up bearer token (401 from authenticate) and a wrong
    // password in a login body (401 from the route). Both fail, so the access
    // log carries their headers and body; redact must hide exactly those.
    const tokenMarker = `tok${randomUUID().replaceAll('-', '')}`;
    const passwordMarker = `pwd${randomUUID().replaceAll('-', '')}`;
    const withToken = traceparent();
    const withPassword = traceparent();
    const tokenRes = await call(pod, 'GET', `/v1/orders/${randomUUID()}`, {
      token: tokenMarker,
      headers: { traceparent: withToken.header },
    });
    const passwordRes = await call(pod, 'POST', '/v1/auth/login', {
      body: { email: buyer.email, password: passwordMarker },
      headers: { traceparent: withPassword.header },
    });
    const secretLogged = () =>
      Boolean(finishedLine(lines(), (l) => l.trace_id === withToken.traceId)) &&
      Boolean(finishedLine(lines(), (l) => l.trace_id === withPassword.traceId));
    await waitFor(secretLogged, 5000);

    const output = pod.log();
    const { nonJson } = parseLog(output);
    const secretHits = output.split(tokenMarker).length - 1 + output.split(passwordMarker).length - 1;

    const values = {
      'first-status': first.status,
      'lines-of-request': own.length,
      layers: new Set(own.map((l) => l.layer)).size,
      'distinct-trace-ids': ownTraceIds.size,
      'trace-id-matches-header': ownTraceIds.size === 1 && ownTraceIds.has(one.traceId) ? 1 : 0,
      burst: BURST,
      'burst-ok': burst.filter((b) => b.status === 201).length,
      'burst-trace-ids': groups.size,
      'burst-uneven': uneven,
      'burst-lines-per-request': modal,
      'burst-matches-header': burstMatchesHeader,
      'secret-token-status': tokenRes.status,
      'secret-password-status': passwordRes.status,
      'secret-req-logged': secretLogged() ? 1 : 0,
      'secret-in-logs': secretHits,
      'non-json-lines': nonJson.length,
    };
    report(values);
    for (const raw of nonJson.slice(0, 3)) console.error('non-json line:', raw);

    finish(
      first.status === 201 &&
        values.layers >= 3 &&
        values['distinct-trace-ids'] === 1 &&
        values['trace-id-matches-header'] === 1 &&
        values['burst-ok'] === BURST &&
        values['burst-trace-ids'] === BURST &&
        uneven === 0 &&
        values['secret-req-logged'] === 1 &&
        secretHits === 0 &&
        nonJson.length === 0,
      'every line is JSON, one request = one trace id in every layer, and no secret in the log',
    );
  } finally {
    await pod.close();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:logs failed:', err);
  process.exit(1);
});
