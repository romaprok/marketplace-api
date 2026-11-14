// npm run demo:image — the production image measured from the outside: how
// many stages, whether a shell exists, which uid runs node, and whether the
// build-time registry token ended up anywhere. Three places for the token,
// because no single tool sees both leaks: an ARG shows in history and not in
// layers, COPY + rm shows in a layer and not in history.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const IMAGE = process.env.IMAGE ?? 'marketplace-api:hw28';
const DOCKERFILE = process.env.DOCKERFILE ?? 'docker/Dockerfile';
const TOKEN_FILE = '.npm_token';

if (!existsSync(TOKEN_FILE)) {
  console.error(`${TOKEN_FILE} is missing: it is the build-time secret this demo looks for (README, Grading)`);
  process.exit(1);
}
const token = readFileSync(TOKEN_FILE, 'utf8').trim();
const needle = Buffer.from(token);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const count = (text) => text.split(token).length - 1;

// stages: FROM lines of the Dockerfile the image is built from
const stages = (readFileSync(DOCKERFILE, 'utf8').match(/^FROM\s/gim) ?? []).length;

// a shell is checked by running one, not by reading the Dockerfile: a base
// inherited from someone else's image could bring it along
const sh = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', 'echo shell-here'], { encoding: 'utf8' });
const shellInside = sh.status === 0 && sh.stdout.includes('shell-here') ? 1 : 0;

// the uid node really runs as (distroless has no `id`, node is the entrypoint)
const uidRun = spawnSync('docker', ['run', '--rm', IMAGE, '-e', 'console.log(process.getuid())'], { encoding: 'utf8' });
const runtimeUid = uidRun.status === 0 ? uidRun.stdout.trim() : '';

const inHistory = count(docker('history', '--no-trunc', '--format', '{{.CreatedBy}}', IMAGE));
const inConfig = count(docker('image', 'inspect', IMAGE));

// The layers: docker save, unpack, and read every layer the manifest lists.
// A file deleted in a later layer is only a whiteout there; its bytes are
// still in the layer that added it.
const dir = mkdtempSync(join(tmpdir(), 'demo-image-'));
let inLayers = 0;
let layersScanned = 0;
try {
  const tar = join(dir, 'image.tar');
  docker('save', '-o', tar, IMAGE);
  execFileSync('tar', ['-xf', tar, '-C', dir]);
  const [manifest] = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const layer of manifest.Layers) {
    let bytes = readFileSync(join(dir, layer));
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    layersScanned++;
    if (bytes.indexOf(needle) !== -1) inLayers++;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`image=${IMAGE}`);
for (const [key, value] of Object.entries({
  stages,
  'shell-inside': shellInside,
  'runtime-uid': runtimeUid,
  'token-in-history': inHistory,
  'token-in-config': inConfig,
  'token-in-layers': inLayers,
  'layers-scanned': layersScanned,
})) {
  console.log(`${key}=${value}`);
}

const ok = stages >= 2 && shellInside === 0 && runtimeUid !== '' && runtimeUid !== '0' &&
  inHistory === 0 && inConfig === 0 && inLayers === 0 && layersScanned > 0;
if (!ok) console.error('invariant violated: a production image has 2+ stages, no shell, a non-root uid and no build secret in it');
process.exitCode = ok ? 0 : 1;
