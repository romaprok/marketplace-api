// npm run demo:upload — intent, then the bytes go straight to storage while
// our API is down, then commit. And what must not work: a commit without
// bytes, a URL pointed at another key, a URL past its lifetime.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseOrExit, storageSchema } from './config/storage-env.js';
import { call, createUser, login } from './demo-auth-kit.js';
import { clearDemoUploads, portAlive } from './demo-files-kit.js';
import { finish, prepareDb, report, sleep } from './demo-kit.js';
import { demoRateLimitName, startPod } from './demo-redis-kit.js';
import { presignPut } from './files/uploads.js';
import { createStorage } from './storage/s3.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PUT from a separate process that has nothing in its env but PATH
async function putFromBareProcess(url: string, contentType: string, body: Buffer) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./demo-put.js', import.meta.url)), url, contentType], {
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stdin.end(body);
  await once(child, 'exit');
  return JSON.parse(out) as { status: number; secretsInEnv: number };
}

const put = (url: string, contentType: string, body: Buffer) =>
  fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(body) }).then((r) => r.status);

async function main() {
  const storage = createStorage(parseOrExit(storageSchema));
  const ds = await prepareDb({}, clearDemoUploads(storage));
  const env = { DEMO_RATE_LIMIT_NAME: demoRateLimitName() };
  let pod = await startPod(env);
  try {
    const user = await createUser(ds, 'buyer');
    const { access } = await login(pod, user);
    const bytes = Buffer.concat([PNG, randomBytes(64 * 1024)]);

    // a filename that would walk out of the user's prefix if it ever reached the key
    const intent = await call(pod, 'POST', '/v1/uploads/intent', {
      token: access,
      body: { content_type: 'image/png', size: bytes.length, filename: '../../etc/passwd' },
    });
    const key: string = intent.body.key;
    const keyFromServer =
      new RegExp(`^uploads/${user.id}/[0-9a-f-]{36}\\.png$`).test(key) && !key.includes('passwd') && !key.includes('..');

    // our API goes down before a single byte moves
    const apiPort = Number(new URL(pod.url).port);
    await pod.close();
    const apiAlive = await portAlive(apiPort);
    const offline = await putFromBareProcess(intent.body.upload.url, intent.body.upload.headers['content-type'], bytes);

    // back up on another port: fetch may still hold a pooled socket to the old one
    pod = await startPod(env);
    const commit = await call(pod, 'POST', '/v1/uploads/commit', { token: access, body: { file_id: intent.body.file_id } });

    // and read it back: our guard, then a 302 to a one-minute presigned GET
    const redirect = await fetch(`${pod.url}/v1/files/${intent.body.file_id}`, {
      headers: { authorization: `Bearer ${access}` },
      redirect: 'manual',
    });
    const downloaded = Buffer.from(await (await fetch(redirect.headers.get('location')!)).arrayBuffer());

    // an intent nobody uploaded anything for, committed right away
    const empty = await call(pod, 'POST', '/v1/uploads/intent', {
      token: access,
      body: { content_type: 'image/png', size: 1024 },
    });
    const commitWithoutBytes = await call(pod, 'POST', '/v1/uploads/commit', {
      token: access,
      body: { file_id: empty.body.file_id },
    });

    // the same signed URL pointed at another key, and with another content type
    const emptyUrl: string = empty.body.upload.url;
    const tampered = await put(emptyUrl.replace(empty.body.key, `uploads/${user.id}/${randomUUID()}.png`), 'image/png', bytes);
    const wrongType = await put(emptyUrl, 'text/html', bytes);

    // a URL signed for 2 s by the same code: works, then the same URL stops
    const short = await presignPut(storage, empty.body.key, 'image/png', 2);
    const beforeExpiry = await put(short, 'image/png', bytes);
    await sleep(3000);
    const expired = await put(short, 'image/png', bytes);

    report({
      intent: intent.status,
      'key-from-server': keyFromServer ? 1 : 0,
      'api-alive': apiAlive ? 1 : 0,
      'put-offline': offline.status,
      'put-process-secrets': offline.secretsInEnv,
      commit: commit.status,
      download: redirect.status === 302 && downloaded.equals(bytes) ? 200 : 0,
      'commit-without-bytes': commitWithoutBytes.status,
      tampered,
      'wrong-type': wrongType,
      'before-expiry': beforeExpiry,
      expired,
    });

    finish(
      intent.status === 200 && keyFromServer && !apiAlive && offline.status === 200 && offline.secretsInEnv === 0 &&
        commit.status === 200 && downloaded.equals(bytes) && commitWithoutBytes.status >= 400 &&
        commitWithoutBytes.status < 500 && tampered === 403 && wrongType === 403 && beforeExpiry === 200 &&
        expired === 403,
      'bytes reach storage without our API, commit checks the store, the signature covers key, type and time',
    );
  } finally {
    await pod.close();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:upload failed:', err);
  process.exit(1);
});
