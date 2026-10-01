import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source.js';
import { Order } from './entities/Order.js';
import { OrderItem } from './entities/OrderItem.js';
import { Product } from './entities/Product.js';
import { QueryCountLogger } from './query-count-logger.js';

// order -> order_items -> product: two relation levels, exactly the graph
// the assignment asks to measure on.
async function naive(ds: DataSource): Promise<number> {
  const orderRepo = ds.getRepository(Order);
  const itemRepo = ds.getRepository(OrderItem);
  const productRepo = ds.getRepository(Product);

  const orders = await orderRepo.find(); // 1 query
  for (const order of orders) {
    // N queries — one per order, the textbook N+1 shape
    const items = await itemRepo.createQueryBuilder('item').where('item.order_id = :orderId', { orderId: order.id }).getMany();
    for (const item of items) {
      // another query per item — the same mistake one level deeper
      await productRepo.findOne({ where: { id: item.productId } });
    }
  }
  return orders.length;
}

async function withRelations(ds: DataSource): Promise<number> {
  const orderRepo = ds.getRepository(Order);
  // Default relationLoadStrategy is 'join': both levels come back as LEFT
  // JOINs in a single SELECT, no matter how many orders there are.
  await orderRepo.find({ relations: ['items', 'items.product'] });
  return 1;
}

async function withLeftJoinAndSelect(ds: DataSource): Promise<number> {
  const orderRepo = ds.getRepository(Order);
  await orderRepo
    .createQueryBuilder('order')
    .leftJoinAndSelect('order.items', 'item')
    .leftJoinAndSelect('item.product', 'product')
    .getMany();
  return 1;
}

async function withQueryStrategy(ds: DataSource): Promise<number> {
  const orderRepo = ds.getRepository(Order);
  // relationLoadStrategy: 'query' issues one extra batched query per
  // relation level (WHERE id IN (...)), not one per row — 1 + 2*levels:
  // orders, then all items for those orders, then all products for those
  // items = 3 queries total for this 2-level graph.
  await orderRepo.find({
    relations: ['items', 'items.product'],
    relationLoadStrategy: 'query',
  });
  return 1;
}

async function main() {
  const counter = new QueryCountLogger();
  const ds = new DataSource({ ...dataSourceOptions, logging: ['query'], logger: counter });
  await ds.initialize();

  const collectionSize = await ds.getRepository(Order).count();

  counter.reset();
  await naive(ds);
  const naiveCount = counter.count;

  counter.reset();
  await withRelations(ds);
  const relationsCount = counter.count;

  counter.reset();
  await withLeftJoinAndSelect(ds);
  const leftJoinCount = counter.count;

  counter.reset();
  await withQueryStrategy(ds);
  const queryStrategyCount = counter.count;

  console.log(`Collection size (orders): ${collectionSize}`);
  console.log(`Naive (query-per-item, two levels): ${naiveCount} queries`);
  console.log(`relations: { items: { product: true } } (join strategy): ${relationsCount} queries`);
  console.log(`leftJoinAndSelect (QueryBuilder, same idea): ${leftJoinCount} queries`);
  console.log(`relationLoadStrategy: 'query' (2 levels -> 1 + 2*2): ${queryStrategyCount} queries`);

  await ds.destroy();

  if (naiveCount < collectionSize) {
    console.error(`Expected naive query count >= collection size (${collectionSize}), got ${naiveCount}`);
    process.exit(1);
  }
  if (relationsCount !== 1 || leftJoinCount !== 1) {
    console.error('Expected the join-strategy fixes to run in exactly 1 query');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
