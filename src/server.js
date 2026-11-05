import { createServer } from "node:http";

import { configService } from "./config/config.service.js";
import { createApp } from "./app.js";
import { attachOrdersGateway } from "./orders/orders.gateway.js";

const port = configService.get("PORT");
const warmupMs = configService.get("WARMUP_MS");
const drainMs = configService.get("DRAIN_MS");

let ready = false;
let draining = false;

const app = createApp({ isReady: () => ready && !draining, isDraining: () => draining });
const server = createServer(app);
attachOrdersGateway(server);

// What a real service does before it can serve: migrations, a warm pool,
// caches. Here it's a pause, 0 locally; the Deployment sets about 4 s, so a
// rollout without readiness probes really does send traffic to a pod that
// isn't listening yet (hw-28).
await new Promise((resolve) => setTimeout(resolve, warmupMs));

server.listen(port, () => {
  ready = true;
  console.log(
    `Marketplace API listening on http://localhost:${port}/v1 (env: ${configService.get("NODE_ENV")})`,
  );
});

// The order matters. First /readyz goes red, so the endpoints controller
// takes the pod out of the Service; existing traffic keeps being served for
// the drain; only then the socket closes. close() right away would refuse new
// connections while the balancer still sends them here.
function shutdown(signal) {
  if (draining) return;
  draining = true;
  console.log(`[server] ${signal}: not ready any more, draining for ${drainMs} ms`);
  setTimeout(() => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    // websockets and slow clients don't get to hold the pod past its grace period
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 2000).unref();
  }, drainMs);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
