// npm run demo:multipart — a three-part upload drops after two parts; a new
// process asks the store what it already has and uploads only the third.
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { parseOrExit, storageSchema } from './config/storage-env.js';
import { call, createUser, login } from './demo-auth-kit.js';
import { clearDemoUploads } from './demo-files-kit.js';
import { finish, prepareDb, report } from './demo-kit.js';
import type { UploaderMessage } from './demo-part-uploader.js';
import { demoRateLimitName, startPod } from './demo-redis-kit.js';
import { MiB } from './files/policy.js';
import { createStorage, statusOf } from './storage/s3.js';

const SIZE = 11 * MiB; // 5 + 5 + 1 MiB

async function runUploader(apiUrl: string, token: string, fileId: string, filePath: string, crashAfter: number) {
  const child = fork(
    fileURLToPath(new URL('./demo-part-uploader.js', import.meta.url)),
    [apiUrl, fileId, filePath, String(crashAfter)],
    { env: { PATH: process.env.PATH, DEMO_ACCESS_TOKEN: token }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
  );
  const messages: UploaderMessage[] = [];
  child.on('message', (m) => messages.push(m as UploaderMessage));
  const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];
  const finished = messages.find((m) => m.t === 'finished');
  return {
    uploaded: messages.filter((m) => m.t === 'part').length,
    alreadyThere: finished?.t === 'finished' ? finished.alreadyThere : undefined,
    killed: signal === 'SIGKILL',
    ok: code === 0,
  };
}

async function main() {
  const storage = createStorage(parseOrExit(storageSchema));
  const ds = await prepareDb({}, clearDemoUploads(storage));
  const pod = await startPod({ DEMO_RATE_LIMIT_NAME: demoRateLimitName() });
  const dir = await mkdtemp(join(tmpdir(), 'demo-multipart-'));
  try {
    const { access } = await login(pod, await createUser(ds, 'seller'));
    const bytes = Buffer.concat([Buffer.from([0x1f, 0x8b]), randomBytes(SIZE - 2)]);
    const filePath = join(dir, 'dump.gz');
    await writeFile(filePath, bytes);

    const intent = await call(pod, 'POST', '/v1/uploads/intent', {
      token: access,
      body: { content_type: 'application/gzip', size: SIZE, filename: 'nightly.sql.gz' },
    });
    const { file_id: fileId, key } = intent.body;
    const { part_size: partSize, part_count: partCount } = intent.body.multipart;

    // first process: two parts, then the connection "drops"
    const first = await runUploader(pod.url, access, fileId, filePath, 2);

    // the parts are there, the object is not
    const { s3, bucket } = storage;
    const uploadId: string = (await ds.query(`SELECT upload_id FROM files WHERE id = $1`, [fileId]))[0].upload_id;
    const partsOnStore = (await s3.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))).Parts ?? [];
    const headBefore = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(
      () => 200,
      (err) => statusOf(err) ?? 0,
    );

    // a new process: asks which parts exist, uploads only what's missing
    const second = await runUploader(pod.url, access, fileId, filePath, 0);
    const complete = await call(pod, 'POST', '/v1/uploads/commit', { token: access, body: { file_id: fileId } });

    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const etag = (head.ETag ?? '').replaceAll('"', '');
    const md5 = createHash('md5').update(bytes).digest('hex');
    // multipart ETag: md5 of the parts' md5s plus -N, never the md5 of the file
    const etagMultipart = etag.endsWith(`-${partCount}`) && etag.split('-')[0] !== md5;

    report({
      intent: intent.status,
      'part-size-mib': partSize / MiB,
      'parts-total': partCount,
      'first-process-parts': first.uploaded,
      'first-process-killed': first.killed ? 1 : 0,
      'parts-on-store': partsOnStore.length,
      'head-before-complete': headBefore,
      'already-there': second.alreadyThere ?? -1,
      'resumed-parts': second.uploaded,
      complete: complete.status,
      'size-match': head.ContentLength === SIZE ? 1 : 0,
      'etag-multipart': etagMultipart ? 1 : 0,
    });

    finish(
      intent.status === 200 && partCount === 3 && first.killed && first.uploaded === 2 && partsOnStore.length === 2 &&
        headBefore === 404 && second.ok && second.alreadyThere === 2 && second.uploaded === 1 &&
        complete.status === 200 && head.ContentLength === SIZE && etagMultipart,
      'after a drop only the missing part is uploaded, and the object exists only after Complete',
    );
  } finally {
    await pod.close();
    await rm(dir, { recursive: true, force: true });
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:multipart failed:', err);
  process.exit(1);
});
