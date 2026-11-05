import { S3Client } from '@aws-sdk/client-s3';
import type { StorageEnv } from '../config/storage-env.js';

export interface Storage {
  s3: S3Client;
  bucket: string;
  endpoint?: string;
  region: string;
}

export function createStorage(env: StorageEnv): Storage {
  const s3 = new S3Client({
    region: env.STORAGE_REGION,
    endpoint: env.STORAGE_ENDPOINT,
    // emulators serve http://host/bucket/key, not bucket.host
    forcePathStyle: Boolean(env.STORAGE_ENDPOINT),
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY },
    // A presigned URL is signed before any body exists. With the SDK's default
    // checksums the URL would carry the CRC32 of empty data, and stricter
    // S3-compatible stores reject the upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { s3, bucket: env.STORAGE_BUCKET, endpoint: env.STORAGE_ENDPOINT, region: env.STORAGE_REGION };
}

// The object straight in the bucket, past every cache. Nobody should be able
// to read it this way; demo:cdn uses it to show that.
export function directUrl(storage: Storage, key: string): string {
  return storage.endpoint
    ? `${storage.endpoint}/${storage.bucket}/${key}`
    : `https://${storage.bucket}.s3.${storage.region}.amazonaws.com/${key}`;
}

export const statusOf = (err: unknown): number | undefined =>
  (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
