import pg from "pg";

import { configService } from "../config/config.service.js";
import { createPasswordReader } from "../config/secret.js";

const dbUrl = new URL(configService.get("DB_URL"));
const readPassword = createPasswordReader(
  configService.get("DB_PASSWORD_FILE"),
);

export const pool = new pg.Pool({
  host: dbUrl.hostname,
  port: dbUrl.port ? Number(dbUrl.port) : 5432,
  database: dbUrl.pathname.replace(/^\//, ""),
  user: decodeURIComponent(dbUrl.username),
  password: readPassword,
});

// Without this listener, an idle client still holding a password rotate.sh
// just invalidated crashes the process with an unhandled 'error' event.
pool.on("error", (err) => {
  console.error("Unexpected error on an idle Postgres client:", err.message);
});

export async function checkDbConnection() {
  const { rows } = await pool.query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}
