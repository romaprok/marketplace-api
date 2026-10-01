import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { envSchema } from "../src/config/env.schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "src", "server.js");

describe("env.schema", () => {
  test("applies defaults and coerces strings to numbers", () => {
    const result = envSchema.safeParse({
      DB_URL: "postgres://user@localhost:5432/db",
    });
    assert.equal(result.success, true);
    assert.equal(result.data.PORT, 3000);
    assert.equal(result.data.NODE_ENV, "development");
    assert.equal(typeof result.data.IDEMPOTENCY_TTL_HOURS, "number");
  });

  test("rejects a missing DB_URL", () => {
    const result = envSchema.safeParse({});
    assert.equal(result.success, false);
    assert.ok(
      result.error.issues.some((issue) => issue.path.includes("DB_URL")),
    );
  });

  test("rejects an invalid NODE_ENV", () => {
    const result = envSchema.safeParse({
      DB_URL: "postgres://user@localhost:5432/db",
      NODE_ENV: "nope",
    });
    assert.equal(result.success, false);
  });
});

describe("fail-fast on startup (spawns the real entry point)", () => {
  test("exits non-zero and names the broken variable when DB_URL is missing", () => {
    const env = { ...process.env };
    delete env.DB_URL;
    delete env.DOTENV_CONFIG_PATH;
    env.PWD = __dirname;

    const result = spawnSync(process.execPath, [serverPath], {
      env,
      cwd: path.join(__dirname, "fixtures", "no-env"),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DB_URL/);
  });
});
