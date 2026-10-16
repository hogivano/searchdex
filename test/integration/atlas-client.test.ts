import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AtlasApiError } from '../../src/domain/index.ts';
import { AtlasClient } from '../../src/infrastructure/atlas/http.ts';
import { AtlasSearchIndexGateway } from '../../src/infrastructure/atlas/search-index-gateway.ts';
import { startAtlasServer } from '../fixtures/atlas-server.ts';

/**
 * Exercises the wire: digest handshake, versioned media type, retry policy,
 * error passthrough, and the response mapping that readiness depends on.
 */

const CREDENTIALS = { publicKey: 'testpublic', privateKey: 'testprivate' };
const servers: { close(): Promise<void> }[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function harness(failWith?: number[]) {
  const server = await startAtlasServer({ ...CREDENTIALS, ...(failWith ? { failWith } : {}) });
  servers.push(server);
  const client = new AtlasClient({
    baseUrl: server.url,
    credentials: CREDENTIALS,
    sleep: async () => {},
  });
  return { server, gateway: new AtlasSearchIndexGateway(client, 'group123', 'acme-prod') };
}

test('answers the digest challenge and retries the request once', async () => {
  const { server, gateway } = await harness();

  assert.deepEqual(await gateway.list(), []);

  assert.deepEqual(
    server.requests.map((request) => request.authorized),
    [false, true],
    'expected an unauthenticated probe followed by a digest-authenticated retry',
  );
});

test('round-trips a create through the real response shape', async () => {
  const { gateway } = await harness();

  const created = await gateway.create({
    key: { database: 'jobs', collection: 'job', name: 'job_search' },
    type: 'search',
    definition: { mappings: { dynamic: true } },
    source: 'test',
  });
  assert.equal(created.definitionVersion, 1);

  const deployed = await gateway.get({ database: 'jobs', collection: 'job', name: 'job_search' });
  assert.equal(deployed?.status, 'READY');
  assert.equal(deployed?.queryable, true);
  assert.equal(deployed?.definitionVersion, 1);
  assert.deepEqual(deployed?.hosts, [
    {
      hostname: 'atlas-test-shard-00-00',
      status: 'READY',
      queryable: true,
      servingVersion: 1,
    },
  ]);
});

test('a 404 means "not deployed", not an error', async () => {
  const { gateway } = await harness();
  assert.equal(await gateway.get({ database: 'jobs', collection: 'job', name: 'nope' }), undefined);
});

test('retries a 429 and then succeeds', async () => {
  const { gateway } = await harness([429, 429]);
  assert.deepEqual(await gateway.list(), []);
});

test("a 4xx surfaces Atlas' own error text, unparaphrased", async () => {
  const { gateway } = await harness([400]);

  await assert.rejects(
    () => gateway.list(),
    (error: unknown) => {
      assert.ok(error instanceof AtlasApiError);
      assert.equal(error.httpStatus, 400);
      assert.equal(error.errorCode, 'RATE_LIMITED');
      assert.match(error.details.join(' '), /slow down/);
      return true;
    },
  );
});

test('sends the pinned versioned media type on every request', async () => {
  const { server, gateway } = await harness();
  await gateway.list();
  // The fixture 406s anything else, so reaching a 200 proves the header.
  assert.ok(server.requests.length >= 2);
});
