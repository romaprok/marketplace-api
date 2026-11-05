// Every number of the upload path in one place. README "Files" explains each.

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;

// What may be uploaded. The key's extension comes from here, never from the
// client's filename.
export const ALLOWED_TYPES: Record<string, { ext: string; maxSize: number }> = {
  'image/jpeg': { ext: 'jpg', maxSize: 20 * MiB },
  'image/png': { ext: 'png', maxSize: 20 * MiB },
  'image/webp': { ext: 'webp', maxSize: 20 * MiB },
  // database dumps, the hw-15 backups
  'application/gzip': { ext: 'gz', maxSize: 500 * GiB },
};

// S3 limits: every part except the last is at least 5 MiB, at most 10 000 parts.
export const MIN_PART_SIZE = 5 * MiB;
export const MAX_PARTS = 10_000;

// Below two full parts there is nothing to resume: one PUT, and a dropped
// one costs at most ~10 MiB. From here on a drop costs a part, not the file.
export const MULTIPART_THRESHOLD = 2 * MIN_PART_SIZE;

// Smallest whole-MiB part that still fits the file into 10 000 parts:
// 11 MiB → 5 MiB, 100 GiB → 11 MiB, 500 GiB → 52 MiB.
export function partSizeFor(size: number): number {
  return Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}

export const partCountFor = (size: number) => Math.ceil(size / partSizeFor(size));

// A presigned URL can't be revoked, so it lives only as long as the job needs.
// Photo from a form: the upload starts right away, 20 MiB at 1 Mbit/s is
// under 3 minutes.
export const PUT_URL_TTL_SEC = 5 * 60;
// Part URLs come in batches; when they run out or expire the client asks
// for the next batch. 50 × 5 MiB at 1 Mbit/s is about half an hour, so a
// slow client simply asks again.
export const PART_URL_TTL_SEC = 15 * 60;
export const PARTS_PER_BATCH = 50;
// GET /v1/files/:id → 302: the browser follows it at once.
export const DOWNLOAD_URL_TTL_SEC = 60;
