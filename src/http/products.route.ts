import express from 'express';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { authOf, requireRole } from '../auth/middleware.js';
import { handle } from './async.js';
import { sendProblem } from './problem.js';

const productSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  price: z.number().positive(),
  stock: z.number().int().min(0),
});

export function productsRouter(ds: DataSource): express.Router {
  const router = express.Router();

  // role level: only sellers and admins write to the catalog, a buyer gets 403
  router.post('/v1/products', requireRole('seller', 'admin'), express.json(), handle(async (req, res) => {
    const body = productSchema.safeParse(req.body);
    if (!body.success) {
      const detail = body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return sendProblem(req, res, 400, 'Bad Request', detail);
    }
    // the seller is whoever the token says, never a field in the body
    const [product] = await ds.query(
      `INSERT INTO products (name, description, price, stock, seller_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.data.name, body.data.description, body.data.price, body.data.stock, authOf(res)!.sub],
    );
    res.status(201).set('Location', `/v1/products/${product.id}/card`).json({ id: product.id });
  }));

  return router;
}
