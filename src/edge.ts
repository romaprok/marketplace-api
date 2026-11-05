// The asset edge as its own process: npm run edge.
// Storage env first: a start without the vault names what's missing.
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { parseOrExit, storageSchema } from './config/storage-env.js';
import { createEdge } from './edge/edge.js';
import { createStorage } from './storage/s3.js';

const env = parseOrExit(storageSchema.extend({ EDGE_PORT: z.coerce.number().int().min(0).default(9910) }));

const server = createEdge(createStorage(env)).listen(env.EDGE_PORT, () => {
  const { port } = server.address() as AddressInfo;
  console.log(`[edge] serving /assets/* from bucket ${env.STORAGE_BUCKET} on http://localhost:${port}`);
  // forked by a demo: tell it the port
  process.send?.({ port });
});

// the demo that forked us is gone, so are we
process.on('disconnect', () => process.exit(0));
