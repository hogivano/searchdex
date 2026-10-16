import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SearchdexError } from '../../src/domain/index.ts';
import {
  findConfigFile,
  loadConfigFile,
  resolveClusters,
} from '../../src/infrastructure/config/load-config.ts';
import { loadCredentials } from '../../src/infrastructure/config/credentials.ts';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'searchdex-config-'));
}

test('no config file is not an error — one cluster needs only flags', async () => {
  assert.equal(await findConfigFile(await scratch()), undefined);
});

test('a JSON config is read', async () => {
  const dir = await scratch();
  await writeFile(
    join(dir, 'searchdex.config.json'),
    JSON.stringify({ projectId: 'p1', clusters: ['a', 'b'], concurrency: 5 }),
  );

  const path = await findConfigFile(dir);
  const config = await loadConfigFile(path!);
  assert.deepEqual(config.clusters, ['a', 'b']);
  assert.equal(config.concurrency, 5);
});

test('a JS config may compute its cluster list', async () => {
  const dir = await scratch();
  await writeFile(
    join(dir, 'searchdex.config.mjs'),
    'export default { projectId: "p1", clusters: ["eu", "us"].map((r) => `prod-${r}`) };',
  );

  const config = await loadConfigFile(join(dir, 'searchdex.config.mjs'));
  assert.deepEqual(config.clusters, ['prod-eu', 'prod-us']);
});

test('a config with no clusters is rejected, naming the file', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'searchdex.config.json'), JSON.stringify({ projectId: 'p1' }));

  await assert.rejects(() => loadConfigFile(join(dir, 'searchdex.config.json')), (error: unknown) => {
    assert.ok(error instanceof SearchdexError);
    assert.match(error.message, /searchdex\.config\.json must define a non-empty "clusters" array/);
    return true;
  });
});

test('malformed JSON in a config surfaces as an error, not a crash', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'searchdex.config.json'), '{ "clusters": ');
  await assert.rejects(() => loadConfigFile(join(dir, 'searchdex.config.json')));
});

test('a module that throws on import is reported against the file', async () => {
  const dir = await scratch();
  await writeFile(join(dir, 'searchdex.config.mjs'), 'throw new Error("boom");');

  await assert.rejects(() => loadConfigFile(join(dir, 'searchdex.config.mjs')), (error: unknown) => {
    assert.ok(error instanceof SearchdexError);
    assert.match(error.message, /could not load/);
    assert.match(error.details.join(' '), /boom/);
    return true;
  });
});

test('--cluster overrides the config file', () => {
  const clusters = resolveClusters(
    { projectId: 'p1', clusters: ['a', 'b', 'c'] },
    { cluster: 'b', projectId: undefined },
  );
  assert.deepEqual(clusters, [{ name: 'b', projectId: 'p1' }]);
});

test('a per-cluster projectId beats the top-level one', () => {
  const clusters = resolveClusters(
    { projectId: 'shared', clusters: ['a', { name: 'b', projectId: 'other' }] },
    {},
  );
  assert.deepEqual(clusters, [
    { name: 'a', projectId: 'shared' },
    { name: 'b', projectId: 'other' },
  ]);
});

test('a cluster with no project id anywhere is an error naming the cluster', () => {
  assert.throws(() => resolveClusters({ clusters: ['a'] }, {}), (error: unknown) => {
    assert.ok(error instanceof SearchdexError);
    assert.match(error.message, /no Atlas project id for cluster "a"/);
    return true;
  });
});

test('no cluster at all explains both ways to provide one', () => {
  assert.throws(() => resolveClusters(undefined, {}), (error: unknown) => {
    assert.ok(error instanceof SearchdexError);
    assert.match(error.message, /no cluster specified/);
    assert.match(error.details.join(' '), /--cluster <name> --project-id <id>/);
    assert.match(error.details.join(' '), /searchdex\.config\.json/);
    return true;
  });
});

test('a duplicate cluster name is refused rather than applied to twice', () => {
  // Names key the fan-out, the summary and the resume state; a duplicate would
  // apply twice to one cluster and mark the other complete.
  assert.throws(
    () => resolveClusters({ projectId: 'p1', clusters: ['a', 'b', 'a'] }, {}),
    /duplicate cluster name: a/,
  );
});

test('credentials come from the environment and complain usefully when absent', () => {
  assert.deepEqual(loadCredentials({ ATLAS_PUBLIC_KEY: ' pk ', ATLAS_PRIVATE_KEY: 'sk ' }), {
    publicKey: 'pk',
    privateKey: 'sk',
  });

  for (const env of [{}, { ATLAS_PUBLIC_KEY: 'pk' }, { ATLAS_PUBLIC_KEY: 'pk', ATLAS_PRIVATE_KEY: '  ' }]) {
    assert.throws(() => loadCredentials(env), (error: unknown) => {
      assert.ok(error instanceof SearchdexError);
      assert.match(error.details.join(' '), /Project Search Index Editor/);
      return true;
    });
  }
});
