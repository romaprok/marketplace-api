import { randomUUID } from 'node:crypto';
import type { DeepPartial } from 'typeorm';
import { User } from '../../src/entities/User.js';
import { Product } from '../../src/entities/Product.js';
import { Order } from '../../src/entities/Order.js';

// Test data builders: a test names only the field it cares about, everything
// else is a valid, unique-by-default value. The alternative — a shared file
// of hand-picked fixture objects — is the "wall of fixtures" antipattern from
// the lecture: nobody reads it, and every test silently depends on all of it.

export function aUser(overrides: DeepPartial<User> = {}): DeepPartial<User> {
  const id = randomUUID();
  return {
    email: `user-${id}@example.test`,
    displayName: 'Test User',
    balance: 1000,
    ...overrides,
  };
}

export function aProduct(overrides: DeepPartial<Product> & { seller: DeepPartial<User> }): DeepPartial<Product> {
  return {
    name: 'Test Product',
    description: 'A product created by a test builder.',
    price: 19.99,
    currency: 'UAH',
    status: 'active',
    stock: 10,
    ...overrides,
  };
}

export function anOrder(overrides: DeepPartial<Order> & { buyer: DeepPartial<User> }): DeepPartial<Order> {
  return {
    status: 'pending',
    total: 0,
    currency: 'UAH',
    ...overrides,
  };
}
