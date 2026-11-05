import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3000),

  // Read only by npm run orders-api (the Postgres checkout, hw-22).
  ORDERS_API_PORT: z.coerce.number().int().positive().default(3001),

  DB_URL: z
    .string()
    .min(1, "DB_URL is required, e.g. postgres://user@host:5432/dbname")
    .refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "DB_URL must be a valid connection URL"),

  DB_PASSWORD_FILE: z.string().min(1).default("./secrets/db_password"),

  // Only the order.placed publisher/consumer need it; the HTTP API starts
  // without a broker.
  BROKER_URL: z.string().url().optional(),

  // hw-23: the cache (allkeys-lru) and the queue + sessions box
  // (noeviction). Two instances, so two URLs. The hw-09 API doesn't use them.
  REDIS_URL: z.string().url().optional(),
  REDIS_QUEUE_URL: z.string().url().optional(),

  // hw-24: signing key, its id and the refresh-token pepper. The hw-09 API
  // doesn't use them, so they are optional here; the Postgres API
  // (src/config/api-env.ts) requires them and has no defaults on purpose.
  // No .min(1): .env.example leaves them empty, and a copied .env must still
  // start the hw-09 API.
  JWT_KID: z.string().optional(),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_PREV_KID: z.string().optional(),
  JWT_PREV_PUBLIC_KEY: z.string().optional(),
  REFRESH_TOKEN_PEPPER: z.string().optional(),

  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export function loadEnv(env = process.env) {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    console.error(`Invalid environment configuration:\n${problems}`);
    process.exit(1);
  }

  return result.data;
}
