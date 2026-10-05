import { createServer } from "node:http";

import { configService } from "./config/config.service.js";
import { createApp } from "./app.js";
import { attachOrdersGateway } from "./orders/orders.gateway.js";

const app = createApp();
const server = createServer(app);
attachOrdersGateway(server);

const port = configService.get("PORT");

server.listen(port, () => {
  console.log(
    `Marketplace API listening on http://localhost:${port}/v1 (env: ${configService.get("NODE_ENV")})`,
  );
});
