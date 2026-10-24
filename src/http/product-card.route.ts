import express from 'express';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { z } from 'zod';
import { getProductCard } from '../catalog/product-card.js';
import { sendProblem } from './problem.js';

const idSchema = z.string().uuid();

export function productCardRouter(ds: DataSource, cache: Redis): express.Router {
  const router = express.Router();

  router.get('/v1/products/:productId/card', async (req, res) => {
    const id = idSchema.safeParse(req.params.productId);
    if (!id.success) return sendProblem(req, res, 400, 'Bad Request', 'productId must be a uuid');
    try {
      const card = await getProductCard(ds, cache, id.data);
      if (!card) return sendProblem(req, res, 404, 'Resource not found', `Product ${id.data} was not found.`);
      res.json(card);
    } catch (err) {
      console.error('[api] product card failed:', err);
      sendProblem(req, res, 500, 'Internal Server Error', 'product card failed');
    }
  });

  return router;
}
