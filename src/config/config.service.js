import "dotenv/config";

import { loadEnv } from "./env.schema.js";

const env = loadEnv();

export class ConfigService {
  #env;

  constructor(parsedEnv = env) {
    this.#env = parsedEnv;
  }

  /** @param {keyof typeof env} key */
  get(key) {
    if (!(key in this.#env)) {
      throw new Error(
        `Unknown config key: "${String(key)}". Add it to env.schema.js first.`,
      );
    }
    return this.#env[key];
  }
}

export const configService = new ConfigService();
