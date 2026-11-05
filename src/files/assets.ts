import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { Storage } from '../storage/s3.js';

// Set on the object at upload time: the edge (or CloudFront) caches only what
// the origin allows, and without this header the hit rate is zero.
export const IMMUTABLE = 'public, max-age=31536000, immutable';
// the manifest is the one name that never changes, so every reader re-checks it
export const REVALIDATE = 'no-cache';

// app.css + its bytes → assets/app.15c42ab7.css. New content, new name: an
// update never needs an invalidation, and the old entry in any cache is
// simply never asked for again.
export function hashedKey(name: string, body: Buffer | string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  const dot = name.lastIndexOf('.');
  return `assets/${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
}

export async function publishAsset(storage: Storage, name: string, body: Buffer | string, contentType: string) {
  const key = hashedKey(name, body);
  await storage.s3.send(
    new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: IMMUTABLE }),
  );
  return key;
}

// logical name → current hashed key, what a page (or a deploy step) reads first
export async function publishManifest(storage: Storage, name: string, entries: Record<string, string>) {
  const key = `assets/${name}`;
  await storage.s3.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      Body: JSON.stringify(entries),
      ContentType: 'application/json',
      CacheControl: REVALIDATE,
    }),
  );
  return key;
}
