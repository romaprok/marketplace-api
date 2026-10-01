import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { checkout, InsufficientStockError, InsufficientBalanceError } from './checkout.js';
import { dataSourceOptions } from './data-source.js';
import { Product } from './entities/Product.js';
import { User } from './entities/User.js';

const SELLER_ID = '50000000-0000-4000-8000-000000000001';
const BUYER_ID = '60000000-0000-4000-8000-000000000001';
const PRODUCT_ID = '70000000-0000-4000-8000-000000000001';
const INITIAL_STOCK = 10;
const ATTEMPTS = 50;

async function main() {
  // A single connection pool shared by 50 concurrent transactions — bump
  // max so most of them run truly in parallel instead of queueing one by
  // one at the pool (queueing is harmless correctness-wise, but a pool of
  // 10 would hide how concurrent this actually is).
  const ds = new DataSource({ ...dataSourceOptions, extra: { max: 60 } });
  await ds.initialize();

  const userRepo = ds.getRepository(User);
  const productRepo = ds.getRepository(Product);

  const seller = userRepo.create({ id: SELLER_ID, email: 'race-seller@example.com', displayName: 'Race Seller' });
  await userRepo.save(seller);

  // Balance is deliberately huge — the binding constraint for this demo
  // must be stock, not money, or the "successful" count becomes whatever
  // the balance happens to allow instead of testing oversell protection.
  const buyer = userRepo.create({ id: BUYER_ID, email: 'race-buyer@example.com', displayName: 'Race Buyer', balance: 1_000_000 });
  await userRepo.save(buyer);

  const product = productRepo.create({
    id: PRODUCT_ID,
    seller,
    name: 'Race Demo Product',
    description: 'Used by demo:race to prove no oversell under concurrency.',
    price: 10,
    currency: 'UAH',
    status: 'active',
    stock: INITIAL_STOCK,
  });
  await productRepo.save(product);

  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, () => checkout(ds, BUYER_ID, PRODUCT_ID, 1).then(
      () => ({ ok: true as const }),
      (err) => ({ ok: false as const, err }),
    )),
  );

  const successes = results.filter((r) => r.ok).length;
  const failures = results.length - successes;
  const insufficientStockFailures = results.filter(
    (r) => !r.ok && r.err instanceof InsufficientStockError,
  ).length;
  const insufficientBalanceFailures = results.filter(
    (r) => !r.ok && r.err instanceof InsufficientBalanceError,
  ).length;

  const finalProduct = await productRepo.findOneByOrFail({ id: PRODUCT_ID });
  const negativeStockRows: Array<{ count: string }> = await ds.query(
    'SELECT count(*) FROM products WHERE stock < 0',
  );
  const negativeStockCount = Number(negativeStockRows[0]!.count);

  console.log(`Attempts: ${ATTEMPTS}`);
  console.log(`Successful: ${successes}`);
  console.log(`Failed: ${failures} (insufficient stock: ${insufficientStockFailures}, insufficient balance: ${insufficientBalanceFailures})`);
  console.log(`Final stock: ${finalProduct.stock}`);
  console.log(`Rows with negative stock: ${negativeStockCount}`);

  await ds.destroy();

  const invariantHolds = successes === INITIAL_STOCK && finalProduct.stock === 0 && negativeStockCount === 0;
  if (!invariantHolds) {
    console.error('Oversell invariant violated');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
