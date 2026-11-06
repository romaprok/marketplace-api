#!/usr/bin/env node
// Load generator for demo:rollout. N loops of GET <url>, each response
// writes one line with its status code to <out-file>; no response at all
// (refused, reset, timed out) is 000. Stops on SIGTERM or SIGINT.
// Each loop keeps a steady pace (one request per INTERVAL_MS at most): a
// refused connection comes back instantly, and an unpaced loop would fire
// failures many times faster than successes and inflate the failure share.
//   node scripts/load.mjs <url> <out-file> [concurrency]
import { createWriteStream } from 'node:fs';
import http from 'node:http';

const [url, outFile, concurrencyArg] = process.argv.slice(2);
if (!url || !outFile) {
  console.error('usage: node scripts/load.mjs <url> <out-file> [concurrency]');
  process.exit(2);
}
const concurrency = Number(concurrencyArg ?? 16);
const INTERVAL_MS = 10;
const out = createWriteStream(outFile, { flags: 'a' });
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
let stopping = false;

const once = () =>
  new Promise((resolve) => {
    const req = http.get(url, { agent, timeout: 2000 }, (res) => {
      res.on('error', () => resolve('000'));
      res.on('end', () => resolve(String(res.statusCode)));
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve('000'));
  });

async function loop() {
  while (!stopping) {
    const started = Date.now();
    out.write(`${await once()}\n`);
    const wait = INTERVAL_MS - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

await Promise.all(Array.from({ length: concurrency }, loop));
out.end(() => process.exit(0));
