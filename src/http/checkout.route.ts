import { STATUS_CODES } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { authOf, requireAuth } from '../auth/middleware.js';
import { invalidateProductCard } from '../catalog/product-card.js';
import { InsufficientBalanceError, InsufficientStockError } from '../checkout.js';
import { IdempotencyKeyReusedError, placeOrder } from '../place-order.js';
import { sendProblem } from './problem.js';

const bodySchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
});

// POST /v1/checkout: the Postgres order write behind an Idempotency-Key.
// No in-memory store like hw-09's middleware. The key lives in
// idempotency_keys and commits together with the order and its outbox row,
// so a retry after a crash or from another instance still finds it.
// With a cache, a new order drops the product card (stock and sales changed).
// Since hw-24 the buyer is whoever the access token says; X-User-Id is gone.
// Before that anyone could order in anyone's name.
export function checkoutRouter(ds: DataSource, cache?: Redis): express.Router {
  const router = express.Router();

  router.post('/v1/checkout', requireAuth, express.json(), async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || key.length > 255) {
      return sendProblem(req, res, 400, 'Bad Request', 'Idempotency-Key header is required (1-255 chars)');
    }
    const body = bodySchema.safeParse(req.body);
    if (!body.success) {
      const detail = body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendProblem(req, res, 400, 'Bad Request', detail);
    }

    try {
      const result = await placeOrder(ds, {
        idempotencyKey: key,
        buyerId: authOf(res)!.sub,
        productId: body.data.product_id,
        quantity: body.data.quantity,
      });
      // a replay answers exactly like the first response, as in hw-09
      if (!result.created) res.set('Idempotency-Replay', 'true');
      else if (cache) await invalidateProductCard(cache, body.data.product_id);
      res.status(201).json({ order_id: result.orderId });
    } catch (err) {
      if (err instanceof IdempotencyKeyReusedError) {
        return sendProblem(req, res, 422, 'Idempotency key reused with a different body', err.message);
      }
      if (err instanceof InsufficientStockError || err instanceof InsufficientBalanceError) {
        return sendProblem(req, res, 409, 'Conflict', err.message);
      }
      console.error('[orders-api] checkout failed:', err);
      sendProblem(req, res, 500, 'Internal Server Error', 'checkout failed');
    }
  });

  // Broken JSON or a too large body from express.json(). Without this,
  // Express answers with its HTML error page and a stack trace.
  // Four params, or Express won't treat it as an error handler.
  router.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[orders-api] unexpected error:', err);
    sendProblem(req, res, status, STATUS_CODES[status] ?? 'Error', status === 500 ? 'checkout failed' : err.message);
  });

  return router;
}
