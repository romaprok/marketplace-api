import { createServer, type Server } from 'node:http';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { statusOf, type Storage } from '../storage/s3.js';

// The local stand-in for CloudFront + OAC: the bucket stays private, the edge
// reads it with its own credentials, keeps what the origin marked cacheable
// and answers with X-Cache: HIT | MISS. The public never talks to the bucket.

const MAX_ENTRIES = 1000;

interface Entry {
  body: Buffer;
  headers: Record<string, string>;
  expiresAt: number;
}

// How long the edge may keep a response, decided by the origin's own
// Cache-Control. no-cache, no-store and private are never kept.
export function cacheableFor(cacheControl: string | undefined): number {
  if (!cacheControl || /no-store|no-cache|private/.test(cacheControl) || !/\bpublic\b/.test(cacheControl)) return 0;
  const maxAge = /max-age=(\d+)/.exec(cacheControl);
  return maxAge ? Number(maxAge[1]) : 0;
}

export function createEdge(storage: Storage): Server {
  const cache = new Map<string, Entry>();

  return createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://edge').pathname);
    const key = path.slice(1);
    // only public assets go through here; uploads stay private (302 + presigned)
    if (req.method !== 'GET' || !key.startsWith('assets/') || key.split('/').some((s) => s === '..' || s === '.')) {
      res.writeHead(404).end();
      return;
    }

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      res.writeHead(200, { ...cached.headers, 'x-cache': 'HIT' }).end(cached.body);
      return;
    }

    try {
      const object = await storage.s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
      const body = Buffer.from(await object.Body!.transformToByteArray());
      const headers = {
        'content-type': object.ContentType ?? 'application/octet-stream',
        // passed on, so browsers and proxies behind us cache the same way
        'cache-control': object.CacheControl ?? 'no-cache',
        etag: object.ETag ?? '',
      };
      const ttl = cacheableFor(object.CacheControl);
      if (ttl > 0) {
        cache.set(key, { body, headers, expiresAt: Date.now() + ttl * 1000 });
        // a real edge evicts too; oldest first is enough here
        if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      }
      res.writeHead(200, { ...headers, 'x-cache': 'MISS' }).end(body);
    } catch (err) {
      res.writeHead(statusOf(err) === 404 ? 404 : 502, { 'x-cache': 'MISS' }).end();
    }
  });
}
