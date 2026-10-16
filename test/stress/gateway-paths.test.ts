import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AtlasClient } from '../../src/infrastructure/atlas/http.ts';
import { AtlasSearchIndexGateway } from '../../src/infrastructure/atlas/search-index-gateway.ts';
import { startAtlasServer } from '../fixtures/atlas-server.ts';
import type { IndexKey } from '../../src/domain/index.ts';

/**
 * Digest authentication hashes the request URI, so the path the client signs and
 * the path it sends have to be byte-identical. Any name needing percent-encoding
 * is where that breaks, and it breaks as a 401 rather than as anything readable.
 */

const CREDENTIALS = { publicKey: 'testpublic', privateKey: 'testprivate' };
const servers: { close(): Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function harness() {
  const server = await startAtlasServer(CREDENTIALS);
  servers.push(server);
  const client = new AtlasClient({ baseUrl: server.url, credentials: CREDENTIALS, sleep: async () => {} });
  return { server, gateway: new AtlasSearchIndexGateway(client, 'group123', 'acme-prod') };
}

const AWKWARD: { label: string; key: IndexKey }[] = [
  { label: 'unicode', key: { database: 'jobs', collection: 'job', name: 'índice_búsqueda' } },
  { label: 'cjk', key: { database: '求人', collection: '仕事', name: '検索' } },
  { label: 'space', key: { database: 'my db', collection: 'my coll', name: 'my index' } },
  { label: 'plus and percent', key: { database: 'a+b', collection: 'c%d', name: 'e f' } },
  { label: 'hyphen and underscore', key: { database: 'a-b', collection: 'c_d', name: 'e.f' } },
  { label: 'ampersand and question mark', key: { database: 'a&b', collection: 'c?d', name: 'e=f' } },
];

for (const { label, key } of AWKWARD) {
  test(`a ${label} namespace survives digest signing and round-trips`, async () => {
    const { gateway } = await harness();

    await gateway.create({ key, type: 'search', definition: { mappings: { dynamic: true } }, source: 'x' });

    const deployed = await gateway.get(key);
    assert.deepEqual(deployed?.key, key, `${label} did not round-trip`);

    // Delete addresses the same encoded path; a mismatch shows up as a 401 here.
    await gateway.delete(key);
    assert.equal(await gateway.get(key), undefined);
  });
}

test('a query string in a name cannot smuggle a parameter into the request', async () => {
  const { server, gateway } = await harness();
  const key = { database: 'jobs', collection: 'job', name: 'x?envelope=true&pretty=true' };

  await gateway.create({ key, type: 'search', definition: {}, source: 'x' });
  await gateway.get(key);

  const paths = server.requests.map((request) => request.path);
  assert.ok(
    paths.every((path) => !path.includes('?envelope=true')),
    `an index name leaked into the query string: ${paths.join(', ')}`,
  );
});

test('a name containing a slash cannot escape its position in the path', async () => {
  const { server, gateway } = await harness();
  const key = { database: 'jobs', collection: 'job', name: '../../../groups/other' };

  await gateway.create({ key, type: 'search', definition: {}, source: 'x' });
  await gateway.get(key).catch(() => undefined);

  assert.ok(
    server.requests.every((request) => !request.path.includes('/../')),
    `path traversal reached the wire: ${server.requests.map((r) => r.path).join(', ')}`,
  );
});

test('the cluster name is encoded too', async () => {
  const server = await startAtlasServer(CREDENTIALS);
  servers.push(server);
  const client = new AtlasClient({ baseUrl: server.url, credentials: CREDENTIALS, sleep: async () => {} });
  const gateway = new AtlasSearchIndexGateway(client, 'group123', 'cluster with space');

  assert.deepEqual(await gateway.list(), []);
  assert.ok(server.requests.some((request) => request.path.includes('cluster%20with%20space')));
});
