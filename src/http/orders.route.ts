import express from 'express';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { authOf, requireAuth } from '../auth/middleware.js';
import { handle } from './async.js';
import { sendProblem } from './problem.js';

const idSchema = z.string().uuid();

export function ordersRouter(ds: DataSource): express.Router {
  const router = express.Router();

  router.get('/v1/orders/:orderId', requireAuth, handle(async (req, res) => {
    const id = idSchema.safeParse(req.params.orderId);
    if (!id.success) return sendProblem(req, res, 400, 'Bad Request', 'orderId must be a uuid');
    const auth = authOf(res)!;

    const [order] = await ds.query(
      `SELECT o.id, o.buyer_id, o.status, o.total::float AS total, o.currency, o.created_at,
              COALESCE(json_agg(json_build_object('product_id', i.product_id, 'quantity', i.quantity))
                       FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
        WHERE o.id = $1
        GROUP BY o.id`,
      [id.data],
    );
    if (!order) return sendProblem(req, res, 404, 'Resource not found', `Order ${id.data} was not found.`);
    // Ownership is checked here, after the row is loaded: only now do we know
    // whose order it is. A guard before the handler would have to load it a
    // second time.
    if (order.buyer_id !== auth.sub && auth.role !== 'admin') {
      return sendProblem(req, res, 403, 'Forbidden', 'this order belongs to another buyer');
    }
    res.json(order);
  }));

  return router;
}
