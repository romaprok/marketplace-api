export const products = [
  {
    id: "prod_1",
    name: "Mechanical Keyboard",
    description: "Hot-swappable 75% mechanical keyboard.",
    price_cents: 12999,
    currency: "USD",
  },
  {
    id: "prod_2",
    name: "Wireless Mouse",
    description: "Ergonomic wireless mouse.",
    price_cents: 4999,
    currency: "USD",
  },
  {
    id: "prod_3",
    name: '27" Monitor',
    description: "27-inch 144Hz IPS monitor.",
    price_cents: 29999,
    currency: "USD",
  },
  {
    id: "prod_4",
    name: "USB-C Hub",
    description: "7-in-1 USB-C hub.",
    price_cents: 3499,
    currency: "USD",
  },
  {
    id: "prod_5",
    name: "Desk Mat",
    description: "Large XXL desk mat.",
    price_cents: 1999,
    currency: "USD",
  },
];

export const orders = [];
let nextOrderId = 1;

export function findProduct(id) {
  return products.find((p) => p.id === id);
}

export function findOrder(id) {
  return orders.find((o) => o.id === id);
}

export function createOrderFromItems(items) {
  let total_cents = 0;
  for (const item of items) {
    const product = findProduct(item.product_id);
    if (!product) {
      const err = new Error(`Unknown product_id: ${item.product_id}`);
      err.statusCode = 400;
      throw err;
    }
    total_cents += product.price_cents * item.quantity;
  }

  const order = {
    id: `order_${nextOrderId++}`,
    items,
    total_cents,
    currency: "USD",
    status: "pending",
    created_at: new Date().toISOString(),
  };
  orders.push(order);
  return order;
}
