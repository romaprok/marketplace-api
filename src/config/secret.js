import { readFile } from "node:fs/promises";
import path from "node:path";

// pg calls this function on every new physical connection — that's what
// makes password rotation take effect without restarting the process.
export function createPasswordReader(filePath) {
  const resolved = path.resolve(filePath);
  return async function readPassword() {
    const raw = await readFile(resolved, "utf8");
    return raw.trim();
  };
}
