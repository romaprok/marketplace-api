import 'reflect-metadata';
import { AppDataSource } from './data-source.js';
import { Order, type OrderStatus } from './entities/Order.js';
import { OrderItem } from './entities/OrderItem.js';
import { Product } from './entities/Product.js';
import { User } from './entities/User.js';

// Fixed, deterministic ids (not gen_random_uuid()) so re-running this script
// upserts the same rows instead of creating new ones — repository.save()
// with an id that already exists in the table does an UPDATE, not a second
// INSERT, which is what makes this idempotent.
function id(kind: 'user' | 'product' | 'order' | 'item', n: number): string {
  const prefix = { user: '10000000', product: '20000000', order: '30000000', item: '40000000' }[kind];
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const BASE_DATE = new Date('2026-01-01T00:00:00Z');
function daysAfterBase(days: number): Date {
  return new Date(BASE_DATE.getTime() + days * 24 * 60 * 60 * 1000);
}

const USERS = [
  { name: 'Анна Коваленко', email: 'anna@example.com' },
  { name: 'Богдан Шевченко', email: 'bogdan@example.com' },
  { name: 'Віра Мельник', email: 'vira@example.com' },
  { name: 'Дмитро Бондаренко', email: 'dmytro@example.com' },
  { name: 'Олена Ткаченко', email: 'olena@example.com' },
  { name: 'Іван Кравченко', email: 'ivan@example.com' },
  { name: 'Марія Олійник', email: 'maria@example.com' },
  { name: 'Сергій Павленко', email: 'serhii@example.com' },
];

const PRODUCTS = [
  { name: 'Шкіряні кросівки', description: 'Класична модель, натуральна шкіра.', price: 89.99 },
  { name: 'Зручний рюкзак', description: 'Водостійкий, 20 л.', price: 54.5 },
  { name: 'Спортивна куртка', description: 'Легка, для будь-якої погоди.', price: 120.0 },
  { name: 'Механічна клавіатура', description: 'Hot-swap, RGB.', price: 79.0 },
  { name: 'Бездротові навушники', description: 'Шумозаглушення, 30 год автономності.', price: 65.3 },
  { name: 'Класичний годинник', description: 'Сталевий корпус, шкіряний ремінець.', price: 145.0 },
  { name: 'Тепла шапка', description: 'Вовна, унісекс.', price: 19.99 },
  { name: 'Зручні сандалі', description: 'Літня колекція.', price: 34.5 },
  { name: 'Портфель для ноутбука', description: 'До 15 дюймів, кілька відділень.', price: 58.0 },
  { name: 'Спортивні окуляри', description: 'UV-захист, поляризація.', price: 27.75 },
  { name: 'Термокружка', description: '500 мл, тримає тепло 12 год.', price: 22.0 },
  { name: 'Класична сумка', description: 'Штучна шкіра, місткий формат.', price: 68.4 },
];

const STATUS_CYCLE: OrderStatus[] = ['paid', 'paid', 'pending', 'paid', 'cancelled'];

async function main() {
  await AppDataSource.initialize();

  const userRepo = AppDataSource.getRepository(User);
  const productRepo = AppDataSource.getRepository(Product);
  const orderRepo = AppDataSource.getRepository(Order);
  const itemRepo = AppDataSource.getRepository(OrderItem);

  const users: User[] = [];
  for (let i = 0; i < USERS.length; i++) {
    const u = USERS[i]!;
    const user = new User();
    user.id = id('user', i);
    user.email = u.email;
    user.displayName = u.name;
    users.push(await userRepo.save(user));
  }

  const products: Product[] = [];
  for (let i = 0; i < PRODUCTS.length; i++) {
    const p = PRODUCTS[i]!;
    const product = new Product();
    product.id = id('product', i);
    product.seller = users[i % users.length]!;
    product.name = p.name;
    product.description = p.description;
    product.price = p.price;
    product.currency = 'UAH';
    product.status = 'active';
    products.push(await productRepo.save(product));
  }

  const ORDER_COUNT = 25;
  for (let i = 0; i < ORDER_COUNT; i++) {
    const order = new Order();
    order.id = id('order', i);
    order.buyer = users[i % users.length]!;
    order.status = STATUS_CYCLE[i % STATUS_CYCLE.length]!;
    order.currency = 'UAH';
    order.createdAt = daysAfterBase(i);
    order.total = 0;
    await orderRepo.save(order);

    const itemCount = 1 + (i % 3); // 1..3 items per order, deterministic
    let total = 0;
    for (let j = 0; j < itemCount; j++) {
      const product = products[(i * 3 + j) % products.length]!;
      const quantity = 1 + ((i + j) % 3);
      const item = new OrderItem();
      item.id = id('item', i * 3 + j);
      item.order = order;
      item.product = product;
      item.quantity = quantity;
      item.unitPrice = product.price;
      await itemRepo.save(item);
      total += product.price * quantity;
    }

    order.total = Math.round(total * 100) / 100;
    await orderRepo.save(order);
  }

  const counts = {
    users: await userRepo.count(),
    products: await productRepo.count(),
    orders: await orderRepo.count(),
    orderItems: await itemRepo.count(),
  };
  console.log('Seed complete:', counts);

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
