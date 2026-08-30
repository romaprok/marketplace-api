import { configService } from "./config/config.service.js";
import { createApp } from "./app.js";

const app = createApp();
const port = configService.get("PORT");

app.listen(port, () => {
  console.log(
    `Marketplace API listening on http://localhost:${port}/v1 (env: ${configService.get("NODE_ENV")})`,
  );
});
