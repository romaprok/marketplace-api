import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(3000),

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
