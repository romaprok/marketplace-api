import "dotenv/config";

import { envSchema, loadEnv } from "./env.schema.js";

const env = loadEnv();
// Typos are caught against the schema, not the parsed values: an optional
// variable that isn't set is simply absent from those.
const knownKeys = new Set(Object.keys(envSchema.shape));

export class ConfigService {
  #env;

  constructor(parsedEnv = env) {
    this.#env = parsedEnv;
  }

  /** @param {keyof typeof env} key */
  get(key) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `Unknown config key: "${String(key)}". Add it to env.schema.js first.`,
      );
    }
    return this.#env[key];
  }
}

export const configService = new ConfigService();
