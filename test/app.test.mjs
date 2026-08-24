import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { start, request } from './helpers.mjs';

describe('Marketplace API (contract enforced by express-openapi-validator)', () => {
  let base;
  let close;

  before(async () => {
    ({ base, close } = await start());
  });
  after(() => close());

  describe('Products', () => {
    test('GET /v1/products returns a page with items + next_cursor', async () => {
      const res = await request(base, 'GET', '/v1/products');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
      assert.ok('next_cursor' in res.body);
    });

    test('GET /v1/products?limit=2 respects the limit and returns a cursor', async () => {
      const res = await request(base, 'GET', '/v1/products?limit=2');
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 2);
      assert.ok(res.body.next_cursor);
    });

    test('cursor walks to the next page without repeating items', async () => {
      const first = await request(base, 'GET', '/v1/products?limit=2');
      const second = await request(base, 'GET', `/v1/products?limit=2&cursor=${first.body.next_cursor}`);
      assert.equal(second.status, 200);
      const firstIds = first.body.items.map((p) => p.id);
      const secondIds = second.body.items.map((p) => p.id);
      assert.equal(new Set([...firstIds, ...secondIds]).size, firstIds.length + secondIds.length);
    });

    test('GET /v1/products?cursor=<garbage> returns 400 problem+json', async () => {
      const res = await request(base, 'GET', '/v1/products?cursor=%25%25%25');
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/problem\+json/);
      assert.equal(res.body.status, 400);
    });

    test('GET /v1/products/:id returns 404 problem+json for unknown id', async () => {
      const res = await request(base, 'GET', '/v1/products/does-not-exist');
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /application\/problem\+json/);
      assert.equal(res.body.title, 'Resource not found');
    });

    test('GET /v1/products/:id returns the product when it exists', async () => {
      const res = await request(base, 'GET', '/v1/products/prod_1');
      assert.equal(res.status, 200);
      assert.equal(res.body.id, 'prod_1');
    });
  });

  describe('Orders — validation', () => {
    test('POST /v1/orders without Idempotency-Key returns 400 problem+json', async () => {
      const res = await request(base, 'POST', '/v1/orders', { items: [{ product_id: 'prod_1', quantity: 1 }] });
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/problem\+json/);
      assert.match(res.body.detail, /idempotency-key/i);
    });

    test('POST /v1/orders with empty items returns 400 problem+json', async () => {
      const res = await request(base, 'POST', '/v1/orders', { items: [] }, { 'Idempotency-Key': 'empty-items' });
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/problem\+json/);
    });

    test('POST /v1/orders with an unknown product_id returns 400 problem+json', async () => {
      const res = await request(
        base,
        'POST',
        '/v1/orders',
        { items: [{ product_id: 'nope', quantity: 1 }] },
        { 'Idempotency-Key': 'unknown-product' },
      );
      assert.equal(res.status, 400);
      assert.match(res.body.detail, /Unknown product_id/);
    });
  });

  describe('Orders — happy path + idempotency', () => {
    const key = 'test-key-1';
    const payload = { items: [{ product_id: 'prod_1', quantity: 2 }] };

    test('POST /v1/orders creates an order and returns 201 + Location', async () => {
      const res = await request(base, 'POST', '/v1/orders', payload, { 'Idempotency-Key': key });
      assert.equal(res.status, 201);
      assert.ok(res.headers.get('location'));
      assert.equal(res.body.total_cents, 25998);
      assert.equal(res.body.status, 'pending');
      assert.ok(!res.headers.get('idempotency-replay'));
    });

    test('retrying the same key + same body replays the original response', async () => {
      const res = await request(base, 'POST', '/v1/orders', payload, { 'Idempotency-Key': key });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get('idempotency-replay'), 'true');
      assert.equal(res.body.total_cents, 25998);
    });

    test('reusing the same key with a different body returns 422 problem+json', async () => {
      const res = await request(
        base,
        'POST',
        '/v1/orders',
        { items: [{ product_id: 'prod_2', quantity: 1 }] },
        { 'Idempotency-Key': key },
      );
      assert.equal(res.status, 422);
      assert.match(res.headers.get('content-type'), /application\/problem\+json/);
      assert.equal(res.body.status, 422);
    });

    test('GET /v1/orders/:id returns the created order', async () => {
      const created = await request(base, 'POST', '/v1/orders', payload, { 'Idempotency-Key': 'fetch-me' });
      const res = await request(base, 'GET', `/v1/orders/${created.body.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.id, created.body.id);
    });

    test('GET /v1/orders/:id returns 404 problem+json for unknown id', async () => {
      const res = await request(base, 'GET', '/v1/orders/does-not-exist');
      assert.equal(res.status, 404);
      assert.match(res.headers.get('content-type'), /application\/problem\+json/);
    });

    test('GET /v1/orders lists created orders with cursor pagination shape', async () => {
      const res = await request(base, 'GET', '/v1/orders?limit=1');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.items));
      assert.ok('next_cursor' in res.body);
    });
  });
});
