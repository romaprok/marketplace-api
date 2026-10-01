import 'reflect-metadata';
import { AppDataSource } from './data-source.js';
import { OrderItem } from './entities/OrderItem.js';

// "Revenue per seller, paid orders only" — an aggregate across three joins
// (order_items -> orders -> products -> users) with GROUP BY and SUM. Not
// expressible through find()/relations at all: those return entity trees,
// never a computed aggregate row per group. This is exactly the line where
// Repository stops being enough and QueryBuilder takes over.
interface RevenueRow {
  sellerId: string;
  sellerName: string;
  revenue: string;
  unitsSold: string;
}

async function main() {
  await AppDataSource.initialize();

  const rows = await AppDataSource.getRepository(OrderItem)
    .createQueryBuilder('item')
    .innerJoin('item.order', 'order')
    .innerJoin('item.product', 'product')
    .innerJoin('product.seller', 'seller')
    .where('order.status = :status', { status: 'paid' })
    .select('seller.id', 'sellerId')
    .addSelect('seller.display_name', 'sellerName')
    .addSelect('SUM(item.quantity * item.unit_price)', 'revenue')
    .addSelect('SUM(item.quantity)', 'unitsSold')
    .groupBy('seller.id')
    .addGroupBy('seller.display_name')
    .orderBy('revenue', 'DESC')
    .getRawMany<RevenueRow>();

  // pg returns SUM(...) as a string (avoids silent bigint/precision loss) —
  // parse explicitly rather than relying on implicit coercion.
  const report = rows.map((r) => ({
    seller: r.sellerName,
    revenue: Number(r.revenue),
    unitsSold: Number(r.unitsSold),
  }));

  console.table(report);

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
