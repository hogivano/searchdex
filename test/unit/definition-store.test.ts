import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DefinitionError } from '../../src/domain/index.ts';
import { FileDefinitionStore } from '../../src/infrastructure/fs/file-definition-store.ts';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'searchdex-store-'));
  return { dir, store: new FileDefinitionStore(dir) };
}

test('a missing directory loads as empty, not as an error', async () => {
  const store = new FileDefinitionStore(join(tmpdir(), 'searchdex-does-not-exist-12345'));
  assert.deepEqual(await store.load(), []);
});

test('the filename is the index identity', async () => {
  const { dir, store } = await scratch();
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');

  const [index] = await store.load();
  assert.deepEqual(index?.key, { database: 'jobs', collection: 'job', name: 'job_search' });
  assert.equal(index?.type, 'search');
  assert.deepEqual(index?.definition, { mappings: { dynamic: true } });
});

test('`type` is read from the file body and kept out of the definition', async () => {
  const { dir, store } = await scratch();
  await writeFile(join(dir, 'jobs.job.vec.json'), '{"type":"vectorSearch","fields":[]}');

  const [index] = await store.load();
  assert.equal(index?.type, 'vectorSearch');
  assert.deepEqual(index?.definition, { fields: [] });
});

test('write then load round-trips', async () => {
  const { store } = await scratch();
  const key = { database: 'jobs', collection: 'job', name: 'job_search' };

  const file = await store.write(key, 'search', { mappings: { dynamic: true } });
  assert.match(file, /jobs\.job\.job_search\.json$/);
  assert.equal((await readFile(file, 'utf8')).endsWith('\n'), true, 'files should end with a newline');

  const [index] = await store.load();
  assert.deepEqual(index?.key, key);
});

test('a malformed filename is reported against the file, not silently skipped', async () => {
  const { dir, store } = await scratch();
  await writeFile(join(dir, 'not-a-namespace.json'), '{}');

  await assert.rejects(() => store.load(), (error: unknown) => {
    assert.ok(error instanceof DefinitionError);
    assert.match(error.message, /<database>\.<collection>\.<indexName>\.json/);
    return true;
  });
});

test('invalid JSON names the file and the parse error', async () => {
  const { dir, store } = await scratch();
  await writeFile(join(dir, 'jobs.job.broken.json'), '{ "mappings": ');

  await assert.rejects(() => store.load(), (error: unknown) => {
    assert.ok(error instanceof DefinitionError);
    assert.match(error.message, /jobs\.job\.broken\.json: is not valid JSON/);
    return true;
  });
});

test('a namespace containing a dot is refused rather than written to a wrong path', async () => {
  const { store } = await scratch();
  await assert.rejects(
    () => store.write({ database: 'jobs.v2', collection: 'job', name: 'search' }, 'search', {}),
    /database contains a "\."/,
  );
});
