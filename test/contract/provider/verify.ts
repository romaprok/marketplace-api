// Provider verification: the real app (src/app.js) has to answer every
// interaction in the consumer's pact. A plain script rather than a jest
// test, because what matters is the Verifier's own output ("has a matching
// body (OK)"), and that prints the same either way.
//
// Without PACT_BROKER_URL it verifies the local pacts/*.json from
// `npm run test:contract`. With it, it pulls the contract from the broker
// and publishes the result back (publishVerificationResult), which is what
// gives can-i-deploy something to answer.
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Verifier, type VerifierOptions } from '@pact-foundation/pact';
import { startTestApp } from '../../testkit/app.js';

const PACT_FILE = path.resolve(process.cwd(), 'pacts', 'marketplace-web-marketplace-api.json');
const providerVersion = process.env.PACT_PROVIDER_VERSION ?? '1.0.0-local';

async function main() {
  if (!process.env.PACT_BROKER_URL && !existsSync(PACT_FILE)) {
    throw new Error(`${PACT_FILE} does not exist, run \`npm run test:contract\` first.`);
  }

  // the real app on a throwaway Postgres, so no .env or vault is needed
  const testApp = await startTestApp();
  const server = testApp.app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  // providerBaseUrl includes /v1: openapi.yaml's servers[0].url is
  // http://localhost:3000/v1, and the consumer pact's request paths (e.g.
  // /products/prod_1) are written to match the spec's bare `paths:` keys,
  // not the app's mount point. Baking /v1 into the base url here is what
  // reconciles the two without editing either side to not match the spec.
  const providerBaseUrl = `http://127.0.0.1:${port}/v1`;

  const stateHandlers = {
    // src/data.js's catalog is a fixed in-memory array that always has
    // prod_1, so there's nothing to seed. Once the catalog moves to Postgres,
    // this becomes an INSERT ... ON CONFLICT (id) DO NOTHING.
    'product prod_1 exists': async () => {},
  };

  const brokerUrl = process.env.PACT_BROKER_URL;
  const brokerToken = process.env.PACT_BROKER_TOKEN;
  const opts: VerifierOptions = brokerUrl
    ? {
        provider: 'marketplace-api',
        providerBaseUrl,
        pactBrokerUrl: brokerUrl,
        // Present only when actually set — the Verifier's option validation
        // rejects an explicit `pactBrokerToken: undefined` key outright
        // (fails with just "pactBrokerToken", no further detail) instead of
        // treating it the same as the key being absent.
        ...(brokerToken ? { pactBrokerToken: brokerToken } : {}),
        publishVerificationResult: true,
        providerVersion,
        consumerVersionSelectors: [{ latest: true }],
        stateHandlers,
        logLevel: 'info',
      }
    : {
        provider: 'marketplace-api',
        providerBaseUrl,
        pactUrls: [PACT_FILE],
        stateHandlers,
        logLevel: 'info',
      };

  console.log(`[verify:provider] mode: ${brokerUrl ? `broker (${brokerUrl})` : 'local pact file'}`);
  console.log(`[verify:provider] providerVersion: ${providerVersion}`);

  try {
    await new Verifier(opts).verifyProvider();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testApp.stop();
  }
}

main().catch((err) => {
  console.error('[verify:provider] failed:', err.message ?? err);
  process.exitCode = 1;
});
