import { fork } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { DataSource } from 'typeorm';
import type { Storage } from './storage/s3.js';

// Everything under a prefix: unfinished multipart uploads first (they are
// invisible in a listing and still billed), then the objects.
export async function clearPrefix(storage: Storage, prefix: string): Promise<void> {
  const { s3, bucket } = storage;
  const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
  for (const u of uploads.Uploads ?? []) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key!, UploadId: u.UploadId! }));
  }
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    token = page.NextContinuationToken;
  } while (token);
}

// prepareDb hook: the previous run's demo users are about to be deleted,
// their rows in files go by cascade, their objects would stay behind
export const clearDemoUploads = (storage: Storage) => async (ds: DataSource, demoEmail: string) => {
  const users: Array<{ id: string }> = await ds.query(`SELECT id FROM users WHERE email LIKE $1`, [demoEmail]);
  for (const { id } of users) await clearPrefix(storage, `uploads/${id}/`);
};

// A raw socket, not fetch: fetch keeps pooled connections per host:port and
// can answer from a dead one.
export function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export interface Child {
  url: string;
  close(): Promise<void>;
}

// npm run edge, forked: it reports its port over IPC
export async function startEdge(): Promise<Child> {
  const child = fork(fileURLToPath(new URL('./edge.js', import.meta.url)), {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, EDGE_PORT: '0' },
  });
  const [{ port }] = (await once(child, 'message')) as [{ port: number }];
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    },
  };
}
