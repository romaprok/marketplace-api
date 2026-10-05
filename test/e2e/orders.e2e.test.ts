import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { startTestApp, type TestApp } from '../testkit/app.js';

// The app is Express (hw-09), not Nest, so there's no
// Test.createTestingModule: supertest drives src/app.js's own createApp(),
// the same factory the server uses. /orders still lives in memory
// (src/data.js), so this proves create → read over real HTTP, while the
// database part is DB_URL/DB_PASSWORD_FILE resolving to a disposable
// Postgres and /health seeing a live connection. README "Тестування" has
// the full story.
describe('E2E: full Express app via supertest', () => {
  let testApp: TestApp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    testApp = await startTestApp();
    app = testApp.app;
  }, 120000);

  afterAll(async () => {
    await testApp.stop();
  });

  test('health reports real DB connectivity through the testcontainer', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
  });

  test('happy path: create an order, then read it back', async () => {
    const created = await request(app)
      .post('/v1/orders')
      .set('Idempotency-Key', randomUUID())
      .send({ items: [{ product_id: 'prod_1', quantity: 2 }] })
      .expect(201);

    expect(created.body).toMatchObject({
      items: [{ product_id: 'prod_1', quantity: 2 }],
      status: 'pending',
    });
    expect(created.headers.location).toBe(`/v1/orders/${created.body.id}`);

    const fetched = await request(app).get(`/v1/orders/${created.body.id}`).expect(200);
    expect(fetched.body).toEqual(created.body);
  });

  test('unknown order id → 404', async () => {
    const res = await request(app).get('/v1/orders/does-not-exist').expect(404);
    expect(res.body.title).toBe('Resource not found');
  });

  test('missing Idempotency-Key header → 400 from the OpenAPI request validator', async () => {
    await request(app)
      .post('/v1/orders')
      .send({ items: [{ product_id: 'prod_1', quantity: 1 }] })
      .expect(400);
  });
});
