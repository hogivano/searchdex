import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { AtlasApiError } from '../../src/domain/index.ts';
import { AtlasClient } from '../../src/infrastructure/atlas/http.ts';
import { AtlasSearchIndexGateway } from '../../src/infrastructure/atlas/search-index-gateway.ts';
import { startAtlasServer } from '../fixtures/atlas-server.ts';

/**
 * What happens at the edges of the error paths: an Atlas failure that is not a
 * 404, and a failure searchdex did not anticipate at all.
 */
const run = promisify(execFile);
const CLI = new URL('../../src/cli.ts', import.meta.url).pathname;
const CREDENTIALS = { publicKey: 'testpublic', privateKey: 'testprivate' };

const servers: { close(): Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

test('a non-404 error on get propagates instead of reading as "not deployed"', async () => {
  const server = await startAtlasServer({ ...CREDENTIALS, failWith: [403] });
  servers.push(server);
  const client = new AtlasClient({
    baseUrl: server.url,
    credentials: CREDENTIALS,
    sleep: async () => {},
    maxRetries: 0,
  });
  const gateway = new AtlasSearchIndexGateway(client, 'g', 'c');

  // Treating a 403 as "the index is not there" would make apply try to create an
  // index that exists, and drift report a phantom deletion.
  await assert.rejects(
    () => gateway.get({ database: 'd', collection: 'c', name: 'n' }),
    (error: unknown) => {
      assert.ok(error instanceof AtlasApiError);
      assert.equal(error.httpStatus, 403);
      return true;
    },
  );
});

test('an unanticipated failure prints a stack rather than a tidy but wrong message', async () => {
  // A file where the definitions directory should be: not a case searchdex
  // models, so it must not be dressed up as one.
  const file = join(await mkdtemp(join(tmpdir(), 'searchdex-notdir-')), 'definitions');
  await writeFile(file, 'not a directory');

  const result = await run('node', [
    '--experimental-strip-types', CLI, 'diff',
    '--cluster', 'c', '--project-id', 'p', '--dir', file, '--quiet',
  ], {
    env: { ...process.env, ATLAS_PUBLIC_KEY: 'x', ATLAS_PRIVATE_KEY: 'y' },
  }).catch((error: { code?: number; stderr?: string }) => ({ code: error.code, stderr: error.stderr ?? '' }));

  assert.equal((result as { code?: number }).code, 2);
  assert.match((result as { stderr: string }).stderr, /unexpected error/);
  assert.match((result as { stderr: string }).stderr, /ENOTDIR/);
});
