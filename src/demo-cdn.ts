// npm run demo:cdn — the bucket is closed to the public, the edge serves from
// cache, and a new version arrives under a new URL with zero invalidations.
import { parseOrExit, storageSchema } from './config/storage-env.js';
import { clearPrefix, startEdge } from './demo-files-kit.js';
import { finish, report } from './demo-kit.js';
import { publishAsset, publishManifest } from './files/assets.js';
import { createStorage, directUrl } from './storage/s3.js';

const V1 = 'body { color: #b00000; }\n';
const V2 = 'body { color: #00b000; }\n';
const NAME = 'demo-app.css';
const MANIFEST = 'demo-manifest.json';

async function main() {
  const storage = createStorage(parseOrExit(storageSchema));
  await clearPrefix(storage, 'assets/demo-');
  const edge = await startEdge();
  try {
    // deploy 1
    const key1 = await publishAsset(storage, NAME, V1, 'text/css');
    await publishManifest(storage, MANIFEST, { [NAME]: key1 });

    // anonymous, straight into the bucket, past the edge
    const direct = (await fetch(directUrl(storage, key1))).status;

    const miss = await fetch(`${edge.url}/${key1}`);
    const missBody = await miss.text();
    const hit = await fetch(`${edge.url}/${key1}`);
    await hit.text();

    // deploy 2: new content, so a new name; the manifest now points at it
    const key2 = await publishAsset(storage, NAME, V2, 'text/css');
    await publishManifest(storage, MANIFEST, { [NAME]: key2 });

    // a client reads the manifest first (never cached), then what it points to
    const manifest = await fetch(`${edge.url}/assets/${MANIFEST}`);
    const current: string = (await manifest.json())[NAME];
    const fresh = await fetch(`${edge.url}/${current}`);
    const freshBody = await fresh.text();
    const manifestAgain = await fetch(`${edge.url}/assets/${MANIFEST}`);
    await manifestAgain.text();

    // the old entry is still cached and in nobody's way: nothing asks for it any more
    const old = await fetch(`${edge.url}/${key1}`);
    const oldBody = await old.text();

    report({
      direct,
      'edge-miss': miss.status,
      'first-was-miss': miss.headers.get('x-cache') === 'MISS' ? 1 : 0,
      'edge-hit': hit.status,
      'cache-hit': hit.headers.get('x-cache') === 'HIT' ? 1 : 0,
      immutable: /immutable/.test(miss.headers.get('cache-control') ?? '') ? 1 : 0,
      'new-name': key2 !== key1 ? 1 : 0,
      'manifest-points-to-new': current === key2 ? 1 : 0,
      'new-url': fresh.status,
      'content-changed': freshBody === V2 && missBody === V1 ? 1 : 0,
      'manifest-cache-hit': manifestAgain.headers.get('x-cache') === 'HIT' ? 1 : 0,
      'old-url-still-cached': old.headers.get('x-cache') === 'HIT' && oldBody === V1 ? 1 : 0,
    });

    finish(
      direct === 403 && miss.status === 200 && miss.headers.get('x-cache') === 'MISS' && hit.status === 200 &&
        hit.headers.get('x-cache') === 'HIT' && key2 !== key1 && current === key2 && fresh.status === 200 &&
        freshBody === V2 && manifestAgain.headers.get('x-cache') !== 'HIT',
      'the bucket answers only the edge, and an update is a new URL, not an invalidation',
    );
  } finally {
    await edge.close();
  }
}

main().catch((err) => {
  console.error('demo:cdn failed:', err);
  process.exit(1);
});
