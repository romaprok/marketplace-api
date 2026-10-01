import path from 'node:path';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';

const { string, integer } = MatchersV3;

// CONSUMER side of the contract (an imaginary frontend, "marketplace-web"):
// it describes what it expects from GET /products/{productId} per the spec
// (openapi/openapi.yaml, hw-09). Note the path has NO /v1 prefix here — that
// prefix is the server's base url in the spec (servers[0].url), not part of
// the path key under `paths:`. The provider side (test/contract/provider/verify.ts)
// supplies that prefix via providerBaseUrl, so both sides stay literally
// consistent with what openapi.yaml declares.
describe('Pact consumer: marketplace-web expects GET /products/{productId}', () => {
  const provider = new PactV3({
    consumer: 'marketplace-web',
    provider: 'marketplace-api',
    dir: path.resolve(process.cwd(), 'pacts'),
  });

  test('a known product id returns a product matching the OpenAPI schema', async () => {
    provider
      .given('product prod_1 exists')
      .uponReceiving('a request for product prod_1')
      .withRequest({ method: 'GET', path: '/products/prod_1' })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': string('application/json; charset=utf-8') },
        body: {
          id: string('prod_1'),
          name: string('Mechanical Keyboard'),
          price_cents: integer(12999),
          currency: string('USD'),
        },
      });

    await provider.executeTest(async (mockServer) => {
      const res = await fetch(`${mockServer.url}/products/prod_1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: expect.any(String), price_cents: expect.any(Number) });
    });
  });
});
