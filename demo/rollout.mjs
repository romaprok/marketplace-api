// npm run demo:rollout — a rolling update under load, measured. The load
// generator writes the status code of every response to a file; requests,
// ok and failed are counted from that file and nowhere else.
//
//   ROLLOUT_PROFILE=naive npm run demo:rollout   the same rollout without
//   probes, drain or maxUnavailable 0, for comparison; the cluster goes back
//   to hardened afterwards
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTEXT = 'kind-marketplace';
const NS = 'marketplace';
const DEPLOY = 'api';
const URL = 'http://127.0.0.1:30080/v1/products';
const CONCURRENCY = 16;
// after the rollout reports done, old pods may still be draining; keep the
// load on long enough to catch anything they drop (drain is 5 s)
const TAIL_MS = 8000;

const profile = process.env.ROLLOUT_PROFILE ?? 'hardened';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kubectl = (...args) => execFileSync('kubectl', ['--context', CONTEXT, '-n', NS, ...args], { encoding: 'utf8' });
// the same `pulumi up` as npm run up; the wrapper already put the secrets in env
const pulumiUp = (...config) =>
  execFileSync('bash', ['scripts/pulumi-up.sh', ...config.flatMap((c) => ['--config', c])], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
const deployment = () => JSON.parse(kubectl('get', 'deploy', DEPLOY, '-o', 'json'));

async function rolledOut(sinceGeneration) {
  for (;;) {
    const d = deployment();
    const want = d.spec.replicas;
    const s = d.status;
    if (d.metadata.generation > sinceGeneration && s.observedGeneration >= d.metadata.generation &&
        s.updatedReplicas === want && s.availableReplicas === want && (s.replicas ?? 0) === want) return;
    await sleep(200);
  }
}

async function main() {
  // the profile under test, settled before any load (switching it is a rollout of its own)
  pulumiUp(`profile=${profile}`);
  kubectl('rollout', 'status', `deploy/${DEPLOY}`, '--timeout=180s');

  const dir = mkdtempSync(join(tmpdir(), 'demo-rollout-'));
  const codesFile = join(dir, 'codes.txt');
  try {
    const load = spawn(process.execPath, ['scripts/load.mjs', URL, codesFile, String(CONCURRENCY)], { stdio: 'inherit' });
    // the exit promises are taken right away: a child that is already gone
    // by the time once() is called would leave it waiting forever
    const loadExit = once(load, 'exit');
    await sleep(2000);

    // a new revision: only the pod template's REV changes
    const generation = deployment().metadata.generation;
    const started = performance.now();
    const up = spawn('bash', ['scripts/pulumi-up.sh', '--config', `profile=${profile}`, '--config', `rev=${Date.now()}`], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const upExit = once(up, 'exit');
    await rolledOut(generation);
    const rolloutSeconds = (performance.now() - started) / 1000;
    const [upCode] = await upExit;
    if (upCode !== 0) throw new Error(`pulumi up exited with ${upCode}`);

    await sleep(TAIL_MS);
    load.kill('SIGTERM');
    await loadExit;

    const codes = readFileSync(codesFile, 'utf8').split('\n').filter(Boolean);
    const ok = codes.filter((c) => c === '200').length;
    const failed = codes.length - ok;
    const noResponse = codes.filter((c) => c === '000').length;

    for (const [key, value] of Object.entries({
      profile,
      requests: codes.length,
      ok,
      failed,
      'failed-no-response': noResponse,
      'failed-http': failed - noResponse,
      'rollout-seconds': rolloutSeconds.toFixed(1),
      concurrency: CONCURRENCY,
    })) {
      console.log(`${key}=${value}`);
    }

    const pass = failed === 0 && codes.length >= 5000;
    if (!pass) console.error(`invariant violated: a rollout must answer every request (failed=${failed}, requests=${codes.length})`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // whatever was measured, the cluster is left in the correct profile
    if (profile !== 'hardened') {
      pulumiUp('profile=hardened');
      kubectl('rollout', 'status', `deploy/${DEPLOY}`, '--timeout=180s');
    }
  }
}

main().catch((err) => {
  console.error('demo:rollout failed:', err.message);
  process.exit(1);
});
