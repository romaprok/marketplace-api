import { DataSource } from 'typeorm';
import { User } from '../../src/entities/User.js';
import { Product } from '../../src/entities/Product.js';
import { Order } from '../../src/entities/Order.js';
import { OrderItem } from '../../src/entities/OrderItem.js';
import { startTestPostgres, TestPostgres } from '../testkit/postgres.js';
import { aUser, aProduct, anOrder } from '../testkit/builders.js';

describe('Order repository (TypeORM) against real Postgres', () => {
  let pg: TestPostgres;
  let dataSource: DataSource;

  beforeAll(async () => {
    pg = await startTestPostgres();
    dataSource = pg.dataSource;
  }, 120000);

  afterEach(async () => {
    await pg.truncateAll();
  });

  afterAll(async () => {
    await pg.stop();
  });

  test('unknown id resolves to null', async () => {
    const found = await dataSource.getRepository(Order).findOneBy({ id: '00000000-0000-4000-8000-000000000000' });
    expect(found).toBeNull();
  });

  // SQL-dependent behavior #1: a JOIN a mock would just echo back whatever
  // you fed it. Here Postgres has to actually resolve order_items.order_id.
  test('an order is read back together with its items via a JOIN', async () => {
    const buyer = await dataSource.getRepository(User).save(dataSource.getRepository(User).create(aUser()));
    const seller = await dataSource.getRepository(User).save(dataSource.getRepository(User).create(aUser()));
    const product = await dataSource
      .getRepository(Product)
      .save(dataSource.getRepository(Product).create(aProduct({ seller, price: 25 })));

    const order = await dataSource
      .getRepository(Order)
      .save(dataSource.getRepository(Order).create(anOrder({ buyer, total: 50 })));
    await dataSource
      .getRepository(OrderItem)
      .save(dataSource.getRepository(OrderItem).create({ order, product, quantity: 2, unitPrice: 25 }));

    const found = await dataSource.getRepository(Order).findOne({
      where: { id: order.id },
      relations: ['items', 'items.product'],
    });

    expect(found?.items).toHaveLength(1);
    expect(found?.items[0].quantity).toBe(2);
    expect(found?.items[0].product.id).toBe(product.id);
  });

  // The FK case a mock never fails: order_items.product_id REFERENCES
  // products(id) RESTRICT (db/schema.sql / hw-12), enforced by Postgres.
  test('an order item referencing an unknown product violates the FK constraint', async () => {
    const buyer = await dataSource.getRepository(User).save(dataSource.getRepository(User).create(aUser()));
    const order = await dataSource
      .getRepository(Order)
      .save(dataSource.getRepository(Order).create(anOrder({ buyer })));

    await expect(
      dataSource.getRepository(OrderItem).save(
        dataSource.getRepository(OrderItem).create({
          order,
          product: { id: '00000000-0000-4000-8000-000000000000' },
          quantity: 1,
          unitPrice: 10,
        }),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  // SQL-dependent behavior #2: SUM/GROUP BY — the same shape of query as
  // src/report.ts's "revenue per seller" (hw-13), exercised against real
  // rows instead of asserted on a hand-built in-memory array.
  test('revenue per seller aggregates paid orders via GROUP BY', async () => {
    const userRepo = dataSource.getRepository(User);
    const seller = await userRepo.save(userRepo.create(aUser()));
    const buyer = await userRepo.save(userRepo.create(aUser()));
    const product = await dataSource
      .getRepository(Product)
      .save(dataSource.getRepository(Product).create(aProduct({ seller, price: 30 })));

    const orderRepo = dataSource.getRepository(Order);
    const paid = await orderRepo.save(orderRepo.create(anOrder({ buyer, status: 'paid', total: 60 })));
    const pending = await orderRepo.save(orderRepo.create(anOrder({ buyer, status: 'pending', total: 30 })));
    const itemRepo = dataSource.getRepository(OrderItem);
    await itemRepo.save(itemRepo.create({ order: paid, product, quantity: 2, unitPrice: 30 }));
    await itemRepo.save(itemRepo.create({ order: pending, product, quantity: 1, unitPrice: 30 }));

    const rows = await orderRepo
      .createQueryBuilder('o')
      .innerJoin('o.items', 'oi')
      .innerJoin('oi.product', 'p')
      .where('o.status = :status', { status: 'paid' })
      .select('p.seller_id', 'sellerId')
      .addSelect('SUM(oi.quantity * oi.unit_price)', 'revenue')
      .groupBy('p.seller_id')
      .getRawMany<{ sellerId: string; revenue: string }>();

    expect(rows).toHaveLength(1);
    expect(rows[0].sellerId).toBe(seller.id);
    expect(Number(rows[0].revenue)).toBe(60);
  });
});
