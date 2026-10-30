import express from 'express';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { authOf, requireAuth } from '../auth/middleware.js';
import { commitUpload, createIntent, downloadUrl, planParts, UploadError } from '../files/uploads.js';
import type { Storage } from '../storage/s3.js';
import { handle } from './async.js';
import { sendProblem } from './problem.js';

const intentSchema = z.object({
  content_type: z.string().min(1),
  size: z.number().int().positive(),
  // accepted for the UI's sake and deliberately unused: it never reaches the key
  filename: z.string().optional(),
});
const commitSchema = z.object({ file_id: z.string().uuid() });
const idSchema = z.string().uuid();

// Logs carry the file id and the object key, never a presigned URL: the URL
// is the access itself until it expires.
export function uploadsRouter(ds: DataSource, storage: Storage): express.Router {
  const router = express.Router();
  const json = express.json();

  const fail = (req: express.Request, res: express.Response, err: unknown) => {
    if (!(err instanceof UploadError)) throw err;
    const titles: Record<number, string> = { 403: 'Forbidden', 404: 'Resource not found', 409: 'Conflict', 413: 'Payload Too Large', 415: 'Unsupported Media Type' };
    sendProblem(req, res, err.status, titles[err.status] ?? 'Bad Request', err.message);
  };

  router.post('/v1/uploads/intent', requireAuth, json, handle(async (req, res) => {
    const body = intentSchema.safeParse(req.body);
    if (!body.success) return sendProblem(req, res, 400, 'Bad Request', 'content_type and a positive integer size are required');
    try {
      const intent = await createIntent(ds, storage, authOf(res)!.sub, { contentType: body.data.content_type, size: body.data.size });
      console.log(`[files] intent file=${intent.file_id} key=${intent.key} multipart=${Boolean(intent.multipart)}`);
      res.json(intent);
    } catch (err) {
      fail(req, res, err);
    }
  }));

  router.post('/v1/uploads/:fileId/parts', requireAuth, handle(async (req, res) => {
    const id = idSchema.safeParse(req.params.fileId);
    if (!id.success) return sendProblem(req, res, 400, 'Bad Request', 'fileId must be a uuid');
    try {
      res.json(await planParts(ds, storage, authOf(res)!.sub, id.data));
    } catch (err) {
      fail(req, res, err);
    }
  }));

  router.post('/v1/uploads/commit', requireAuth, json, handle(async (req, res) => {
    const body = commitSchema.safeParse(req.body);
    if (!body.success) return sendProblem(req, res, 400, 'Bad Request', 'file_id must be a uuid');
    try {
      const file = await commitUpload(ds, storage, authOf(res)!.sub, body.data.file_id);
      console.log(`[files] committed file=${file.file_id} key=${file.key} size=${file.size}`);
      res.json(file);
    } catch (err) {
      fail(req, res, err);
    }
  }));

  router.get('/v1/files/:fileId', requireAuth, handle(async (req, res) => {
    const id = idSchema.safeParse(req.params.fileId);
    if (!id.success) return sendProblem(req, res, 400, 'Bad Request', 'fileId must be a uuid');
    try {
      res.redirect(302, await downloadUrl(ds, storage, authOf(res)!.sub, id.data));
    } catch (err) {
      fail(req, res, err);
    }
  }));

  return router;
}
