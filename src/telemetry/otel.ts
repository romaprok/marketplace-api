// Tracing for the Postgres API. Loaded with `node --import` before the app
// itself (package.json, demo pods): the instrumentations patch http, express
// and pg when those load, so they must be registered before anything imports
// them. Imported as the first line of orders-api.ts it would be too late,
// ESM links every import of the entry before running any of them.
import { register } from 'node:module';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

// The exporter would quietly fall back to localhost:4318 and drop every span.
// Same rule as the rest of the config: no value, no start, and say which.
if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  console.error('OTEL_EXPORTER_OTLP_ENDPOINT is required: it comes from the vault via scripts/with-secrets.sh (README, Observability)');
  process.exit(1);
}

// Our code is ESM, and express comes in through `import`, past require().
// Without this loader hook the express instrumentation never sees it: no
// route in the span name, no handler span. pg and http are require()d from
// CommonJS inside typeorm and express, so those are patched either way.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const provider = new TracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'marketplace-api' }),
  // Spans leave in batches, every 5 s by default, not one by one. demo:trace
  // sets OTEL_BSP_SCHEDULE_DELAY low so it doesn't wait that long.
  spanProcessors: [
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter(),
      scheduledDelayMillis: Number(process.env.OTEL_BSP_SCHEDULE_DELAY ?? 5000),
    }),
  ],
});

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
// W3C traceparent in and out: an incoming trace id is continued, not replaced
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(provider);

registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [
    // a scrape every 5 s is not a request anyone will ever investigate
    new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/metrics' }),
    // Only the handler that answered. Every router is mounted at the root,
    // so a span per router would be five empty spans per request.
    new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER] }),
    new PgInstrumentation(),
  ],
});

// what's still in the batch goes out before the process does
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    provider.shutdown().finally(() => process.exit(0));
  });
}
