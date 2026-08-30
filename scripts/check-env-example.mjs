#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { envSchema } from "../src/config/env.schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.join(__dirname, "..", ".env.example");

const schemaKeys = new Set(Object.keys(envSchema.shape));

const exampleKeys = new Set(
  readFileSync(examplePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("=")[0].trim())
    .filter(Boolean),
);

const missingInExample = [...schemaKeys].filter((key) => !exampleKeys.has(key));
const extraInExample = [...exampleKeys].filter((key) => !schemaKeys.has(key));

if (missingInExample.length > 0 || extraInExample.length > 0) {
  if (missingInExample.length > 0) {
    console.error(
      `.env.example is missing variables declared in env.schema.js: ${missingInExample.join(", ")}`,
    );
  }
  if (extraInExample.length > 0) {
    console.error(
      `.env.example declares variables the schema doesn't know about: ${extraInExample.join(", ")}`,
    );
  }
  process.exit(1);
}

console.log(
  `.env.example is in sync with env.schema.js (${schemaKeys.size} variables).`,
);
