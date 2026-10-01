import type { DataSource } from 'typeorm';
import { Order } from './entities/Order.js';
import { OrderItem } from './entities/OrderItem.js';
import { Task } from './entities/Task.js';

export class InsufficientStockError extends Error {
  constructor(productId: string) {
    super(`Insufficient stock for product ${productId}`);
    this.name = 'InsufficientStockError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(buyerId: string) {
    super(`Insufficient balance for buyer ${buyerId}`);
    this.name = 'InsufficientBalanceError';
  }
}

export interface CheckoutResult {
  orderId: string;
  total: number;
}

// The key property under concurrent load: no read-modify-write in JS.
// `UPDATE ... SET stock = stock - $qty WHERE id = $id AND stock >= $qty
// RETURNING ...` is both the check and the lock in one atomic statement —
// Postgres evaluates the WHERE clause against the row's current committed
// value at the moment it takes the row lock, so two concurrent checkouts
// for the last unit can never both see "stock >= qty" as true. Zero rows
// back means "not enough stock", full stop — no separate SELECT, no window
// for a race. Plain READ COMMITTED is enough for this; it doesn't need
// SERIALIZABLE/REPEATABLE READ, which is exactly why this pattern is
// preferred over SELECT ... FOR UPDATE + a JS-side check for this case.
export async function checkout(
  dataSource: DataSource,
  buyerId: string,
  productId: string,
  quantity: number,
): Promise<CheckoutResult> {
  return dataSource.transaction(async (manager) => {
    // manager.query() on an UPDATE/DELETE returns a [rows, rowCount] tuple
    // (see TypeORM's PostgresQueryRunner.query — RETURNING rows only come
    // back this way for UPDATE/DELETE commands, unlike SELECT/INSERT which
    // return the rows array directly), so the RETURNING rows are the first
    // element, not the result itself.
    const [stockRows]: [Array<{ price: string; seller_id: string }>, number] = await manager.query(
      `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING price, seller_id`,
      [quantity, productId],
    );
    if (stockRows.length === 0) {
      throw new InsufficientStockError(productId);
    }
    const price = Number(stockRows[0]!.price);
    const total = Math.round(price * quantity * 100) / 100;

    const [balanceRows]: [Array<{ id: string }>, number] = await manager.query(
      `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING id`,
      [total, buyerId],
    );
    if (balanceRows.length === 0) {
      throw new InsufficientBalanceError(buyerId);
    }

    const order = manager.create(Order, {
      buyer: { id: buyerId },
      status: 'paid',
      total,
      currency: 'UAH',
    } as Order);
    await manager.save(order);

    const item = manager.create(OrderItem, {
      order,
      product: { id: productId },
      quantity,
      unitPrice: price,
    } as OrderItem);
    await manager.save(item);

    const task = manager.create(Task, {
      type: 'send_receipt',
      order,
    } as Task);
    await manager.save(task);

    return { orderId: order.id, total };
  });
}
