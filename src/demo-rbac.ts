// npm run demo:rbac — 401 vs 403, the role level (who may write products),
// the ownership level (whose order this is), and a forged token.
import { randomUUID } from 'node:crypto';
import { call, createUser, login, tamper } from './demo-auth-kit.js';
import { finish, prepareDb, report } from './demo-kit.js';
import { demoRateLimitName, startPod } from './demo-redis-kit.js';

async function main() {
  const ds = await prepareDb();
  const pod = await startPod({ DEMO_RATE_LIMIT_NAME: demoRateLimitName() });
  try {
    const seller = await login(pod, await createUser(ds, 'seller'));
    const alice = await login(pod, await createUser(ds, 'buyer', 1000));
    const bob = await login(pod, await createUser(ds, 'buyer', 1000));

    // role level
    const product = { name: 'Demo lamp', price: 10, stock: 5 };
    const roleAllowed = await call(pod, 'POST', '/v1/products', { token: seller.access, body: product });
    const roleDenied = await call(pod, 'POST', '/v1/products', { token: alice.access, body: product });

    // an order that belongs to alice
    const order = await call(pod, 'POST', '/v1/checkout', {
      token: alice.access,
      headers: { 'idempotency-key': randomUUID() },
      body: { product_id: roleAllowed.body.id, quantity: 1 },
    });
    const orderPath = `/v1/orders/${order.body.order_id}`;

    // ownership level
    const own = await call(pod, 'GET', orderPath, { token: alice.access });
    const foreign = await call(pod, 'GET', orderPath, { token: bob.access });
    const anon = await call(pod, 'GET', orderPath);
    const missing = await call(pod, 'GET', `/v1/orders/${randomUUID()}`, { token: alice.access });

    // alice promotes herself to admin by editing the payload
    const forged = tamper(alice.access, { role: 'admin' });
    const tampered = await call(pod, 'POST', '/v1/products', { token: forged, body: product });
    const tamperedForeign = await call(pod, 'GET', orderPath, { token: tamper(bob.access, { role: 'admin' }) });

    report({
      anon: anon.status,
      own: own.status,
      foreign: foreign.status,
      'role-denied': roleDenied.status,
      'role-allowed': roleAllowed.status,
      tampered: tampered.status,
      'tampered-foreign': tamperedForeign.status,
      missing: missing.status,
      checkout: order.status,
      logins: [seller, alice, bob].filter((l) => l.status === 200).length,
    });

    finish(
      anon.status === 401 && own.status === 200 && foreign.status === 403 && roleDenied.status === 403 &&
        (roleAllowed.status === 200 || roleAllowed.status === 201) && tampered.status === 401 &&
        tamperedForeign.status === 401 && missing.status === 404 && order.status === 201,
      '401 for who-are-you, 403 for not-yours, and a forged role is a 401',
    );
  } finally {
    await pod.close();
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error('demo:rbac failed:', err);
  process.exit(1);
});
