// npm run demo:pdb — two evictions in a row through the Eviction API, the
// way `kubectl drain` evicts. The first fits the budget, the second does not.
// A plain `kubectl delete pod` would ignore the PDB entirely: the budget only
// governs evictions.
import { spawnSync, execFileSync } from 'node:child_process';

const CONTEXT = 'kind-marketplace';
const NS = 'marketplace';
const kubectl = (...args) => execFileSync('kubectl', ['--context', CONTEXT, '-n', NS, ...args], { encoding: 'utf8' });

// The status code of the Eviction API call itself, read from kubectl's
// request log (-v=6). No -o here: with --raw it is an error in kubectl 1.33+.
function evict(pod) {
  const body = JSON.stringify({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: pod, namespace: NS } });
  const run = spawnSync(
    'kubectl',
    ['--context', CONTEXT, 'create', '--raw', `/api/v1/namespaces/${NS}/pods/${pod}/eviction`, '-f', '-', '-v=6'],
    { input: body, encoding: 'utf8' },
  );
  const log = `${run.stderr}\n${run.stdout}`;
  const match = /status="(\d{3})/.exec(log) ?? /eviction\s+(\d{3})\s/.exec(log);
  return match ? Number(match[1]) : 0;
}

kubectl('rollout', 'status', 'deploy/api', '--timeout=180s');
const pdb = JSON.parse(kubectl('get', 'pdb', 'api', '-o', 'json'));
const healthy = pdb.status.currentHealthy;
const allowedBefore = pdb.status.disruptionsAllowed;

const pods = JSON.parse(kubectl('get', 'pods', '-l', 'app=marketplace-api', '-o', 'json'))
  .items.filter((p) => p.status.phase === 'Running' && !p.metadata.deletionTimestamp)
  .map((p) => p.metadata.name);

const evict1 = evict(pods[0]);
const evict2 = evict(pods[1]);

// leave the cluster as it was: the evicted pod is replaced and ready again
kubectl('rollout', 'status', 'deploy/api', '--timeout=180s');
let healthyAfter = 0;
for (let i = 0; i < 60 && healthyAfter < healthy; i++) {
  healthyAfter = JSON.parse(kubectl('get', 'pdb', 'api', '-o', 'json')).status.currentHealthy;
  if (healthyAfter < healthy) await new Promise((r) => setTimeout(r, 1000));
}

for (const [key, value] of Object.entries({
  healthy,
  minAvailable: pdb.spec.minAvailable,
  'disruptions-allowed-before': allowedBefore,
  'evict-1': evict1,
  'evict-2': evict2,
  'healthy-after': healthyAfter,
})) {
  console.log(`${key}=${value}`);
}

const pass = evict1 === 201 && evict2 === 429;
if (!pass) console.error('invariant violated: the budget lets exactly one pod go at a time');
process.exitCode = pass ? 0 : 1;
