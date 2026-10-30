import { randomUUID } from 'node:crypto';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DataSource } from 'typeorm';
import { statusOf, type Storage } from '../storage/s3.js';
import {
  ALLOWED_TYPES,
  DOWNLOAD_URL_TTL_SEC,
  MULTIPART_THRESHOLD,
  PART_URL_TTL_SEC,
  PARTS_PER_BATCH,
  partCountFor,
  partSizeFor,
  PUT_URL_TTL_SEC,
} from './policy.js';

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface FileRow {
  id: string;
  owner_id: string;
  key: string;
  size: string; // bigint comes back as a string
  status: 'PENDING' | 'COMPLETED';
  upload_id: string | null;
}

async function loadOwned(ds: DataSource, ownerId: string, fileId: string): Promise<FileRow> {
  const [file]: FileRow[] = await ds.query(
    `SELECT id, owner_id, key, size, status, upload_id FROM files WHERE id = $1`,
    [fileId],
  );
  if (!file) throw new UploadError(404, `File ${fileId} was not found.`);
  if (file.owner_id !== ownerId) throw new UploadError(403, 'this file belongs to another user');
  return file;
}

// The content type is signed, so the client must upload exactly the type
// it declared. demo:upload also uses this with a 2 s lifetime.
export function presignPut(storage: Storage, key: string, contentType: string, expiresIn = PUT_URL_TTL_SEC) {
  return getSignedUrl(storage.s3, new PutObjectCommand({ Bucket: storage.bucket, Key: key, ContentType: contentType }), {
    expiresIn,
    signableHeaders: new Set(['content-type']),
  });
}

// Step 1. The server decides where the bytes go: uploads/{userId}/{uuid}.{ext}.
// Nothing the client sent ends up in the key, so a client can only ever
// write the one object it was given.
export async function createIntent(
  ds: DataSource,
  storage: Storage,
  ownerId: string,
  input: { contentType: string; size: number },
) {
  const type = ALLOWED_TYPES[input.contentType];
  if (!type) throw new UploadError(415, `content type ${input.contentType} is not allowed`);
  if (input.size > type.maxSize) throw new UploadError(413, `at most ${type.maxSize} bytes for ${input.contentType}`);

  const key = `uploads/${ownerId}/${randomUUID()}.${type.ext}`;
  const { s3, bucket } = storage;

  if (input.size < MULTIPART_THRESHOLD) {
    const url = await presignPut(storage, key, input.contentType);
    const [file] = await ds.query(
      `INSERT INTO files (owner_id, key, content_type, size) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ownerId, key, input.contentType, input.size],
    );
    return {
      file_id: file.id as string,
      key,
      upload: { method: 'PUT', url, headers: { 'content-type': input.contentType }, expires_in: PUT_URL_TTL_SEC },
    };
  }

  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.contentType }),
  );
  const [file] = await ds.query(
    `INSERT INTO files (owner_id, key, content_type, size, upload_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ownerId, key, input.contentType, input.size, UploadId],
  );
  // part URLs come from /parts, the same call a resumed client makes
  return {
    file_id: file.id as string,
    key,
    multipart: { part_size: partSizeFor(input.size), part_count: partCountFor(input.size) },
  };
}

// ListParts pages by 1000
async function listParts(storage: Storage, file: FileRow): Promise<Part[]> {
  const parts: Part[] = [];
  let marker: string | undefined;
  do {
    const page = await storage.s3.send(
      new ListPartsCommand({ Bucket: storage.bucket, Key: file.key, UploadId: file.upload_id!, PartNumberMarker: marker }),
    );
    parts.push(...(page.Parts ?? []));
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return parts;
}

// Multipart, first upload and resume alike: ask the store which parts it
// already has, sign URLs only for the missing ones.
export async function planParts(ds: DataSource, storage: Storage, ownerId: string, fileId: string) {
  const file = await loadOwned(ds, ownerId, fileId);
  if (!file.upload_id || file.status !== 'PENDING') throw new UploadError(409, 'not a multipart upload in progress');

  const size = Number(file.size);
  const total = partCountFor(size);
  const done = (await listParts(storage, file)).map((p) => p.PartNumber!).sort((a, b) => a - b);
  const missing = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.includes(n));

  const todo = await Promise.all(
    missing.slice(0, PARTS_PER_BATCH).map(async (partNumber) => ({
      part_number: partNumber,
      url: await getSignedUrl(
        storage.s3,
        new UploadPartCommand({ Bucket: storage.bucket, Key: file.key, UploadId: file.upload_id!, PartNumber: partNumber }),
        { expiresIn: PART_URL_TTL_SEC },
      ),
    })),
  );
  return { part_size: partSizeFor(size), part_count: total, done, todo, expires_in: PART_URL_TTL_SEC };
}

// Step 3. The client says "done"; the store gets the last word. Without the
// HeadObject a client could commit something it never uploaded.
export async function commitUpload(ds: DataSource, storage: Storage, ownerId: string, fileId: string) {
  const file = await loadOwned(ds, ownerId, fileId);
  const size = Number(file.size);
  const { s3, bucket } = storage;

  if (file.status === 'PENDING' && file.upload_id) {
    const parts = await listParts(storage, file);
    const expected = partCountFor(size);
    if (parts.length !== expected) throw new UploadError(409, `${parts.length} of ${expected} parts uploaded`);
    try {
      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: file.key,
          UploadId: file.upload_id,
          MultipartUpload: {
            Parts: parts.sort((a, b) => a.PartNumber! - b.PartNumber!).map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })),
          },
        }),
      );
    } catch (err) {
      const status = statusOf(err);
      if (status && status < 500) throw new UploadError(409, `the store refused to complete: ${(err as Error).name}`);
      throw err;
    }
  }

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: file.key }));
  } catch (err) {
    if (statusOf(err) === 404) throw new UploadError(409, 'nothing was uploaded under this key yet');
    throw err;
  }
  if (head.ContentLength !== size) {
    throw new UploadError(409, `expected ${size} bytes, the store has ${head.ContentLength}`);
  }

  // a repeated commit of a finished upload lands here too and changes nothing
  await ds.query(
    `UPDATE files SET status = 'COMPLETED', completed_at = COALESCE(completed_at, now()) WHERE id = $1`,
    [file.id],
  );
  return { file_id: file.id, key: file.key, size, etag: head.ETag };
}

// Private files are read through us: the guard runs on every request, then a
// presigned GET for one minute. We stay on the authorization path, not on
// the data path.
export async function downloadUrl(ds: DataSource, storage: Storage, ownerId: string, fileId: string): Promise<string> {
  const file = await loadOwned(ds, ownerId, fileId);
  if (file.status !== 'COMPLETED') throw new UploadError(409, 'the upload is not committed yet');
  return getSignedUrl(storage.s3, new GetObjectCommand({ Bucket: storage.bucket, Key: file.key }), {
    expiresIn: DOWNLOAD_URL_TTL_SEC,
  });
}
