import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { cacheAside } from '../cache/cache-aside.js';

export interface ProductCard {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  status: string;
  stock: number;
  seller: string;
  sold: number;
  orders: number;
}

export const productCardKey = (productId: string) => `card:product:${productId}`;

// The heavy read: product + seller + stock + an aggregate over every order
// line of this product. The aggregate is what grows with the shop.
export async function loadProductCard(ds: DataSource, productId: string): Promise<ProductCard | null> {
  const [row] = await ds.query(
    `SELECT p.id, p.name, p.description, p.price, p.currency, p.status, p.stock,
            u.display_name AS seller,
            COALESCE(s.sold, 0)::int AS sold, COALESCE(s.orders, 0)::int AS orders
       FROM products p
       JOIN users u ON u.id = p.seller_id
       LEFT JOIN LATERAL (
         SELECT sum(i.quantity) AS sold, count(DISTINCT i.order_id) AS orders
           FROM order_items i
          WHERE i.product_id = p.id
       ) s ON true
      WHERE p.id = $1`,
    [productId],
  );
  if (!row) return null;
  return { ...row, price: Number(row.price) };
}

export function getProductCard(ds: DataSource, cache: Redis, productId: string): Promise<ProductCard | null> {
  return cacheAside(cache, productCardKey(productId), () => loadProductCard(ds, productId));
}

// On top of the TTL, not instead of it. A failed DEL only means the card is
// stale until the TTL runs out.
export async function invalidateProductCard(cache: Redis, productId: string): Promise<void> {
  try {
    await cache.del(productCardKey(productId));
  } catch (err) {
    console.warn('[cache] invalidation failed, the TTL will catch up:', (err as Error).message);
  }
}
