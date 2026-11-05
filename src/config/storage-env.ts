import { z } from 'zod';

// Object storage (hw-26). Shared by the API, the edge and the demos.
export const storageFields = {
  // empty means AWS S3 itself; set it for MinIO, LocalStack, R2 and friends
  STORAGE_ENDPOINT: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  // no defaults: these keys can read and write every file in the bucket
  STORAGE_ACCESS_KEY: z.string().min(1),
  STORAGE_SECRET_KEY: z.string().min(1),
  STORAGE_BUCKET: z.string().min(1),
};

export const storageSchema = z.object(storageFields);
export type StorageEnv = z.infer<typeof storageSchema>;

// Same message format as the hw-11 config: every missing or broken variable by name.
export function parseOrExit<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    console.error(`Invalid environment configuration:\n${problems}`);
    process.exit(1);
  }
  return result.data;
}
