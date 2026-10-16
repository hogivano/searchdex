import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planCluster } from '../../src/application/plan-cluster.ts';
import { pullCluster } from '../../src/application/pull.ts';
import { FileDefinitionStore } from '../../src/infrastructure/fs/file-definition-store.ts';
import { SchemaValidator } from '../../src/infrastructure/validation/schema-validator.ts';
import { FakeAtlas } from '../fixtures/fake-atlas.ts';

/**
 * The fixtures that decide whether anyone keeps searchdex installed.
 *
 * Every case here is a diff that must report *no changes*. A drift checker that
 * cries wolf gets muted in week two, and then it is worse than not having one.
 */

const KEY = { database: 'jobs', collection: 'job', name: 'job_search' };
const DEFINITION = {
  mappings: {
    dynamic: false,
    fields: { title: { type: 'string', analyzer: 'lucene.english' } },
  },
};

async function scratchStore() {
  const dir = await mkdtemp(join(tmpdir(), 'searchdex-'));
  return { dir, store: new FileDefinitionStore(dir) };
}

test('pull then diff reports no changes', async () => {
  const atlas = new FakeAtlas('acme-prod');
  atlas.seed(KEY, DEFINITION);
  const { store } = await scratchStore();

  await pullCluster(atlas, store, { includeVectorSearch: false });
  const plan = await planCluster(atlas, await store.load(), new SchemaValidator());

  assert.deepEqual(plan.changes, [], 'server defaults leaked into the diff');
  assert.equal(plan.unchanged.length, 1);
});

test('reordered keys in the local file are not a change', async () => {
  const atlas = new FakeAtlas('acme-prod');
  atlas.seed(KEY, DEFINITION);
  const { dir, store } = await scratchStore();

  await writeFile(
    join(dir, 'jobs.job.job_search.json'),
    JSON.stringify({
      mappings: {
        fields: { title: { analyzer: 'lucene.english', type: 'string' } },
        dynamic: false,
      },
    }),
  );

  const plan = await planCluster(atlas, await store.load(), new SchemaValidator());
  assert.deepEqual(plan.changes, []);
});

test('whitespace-only differences are not a change', async () => {
  const atlas = new FakeAtlas('acme-prod');
  atlas.seed(KEY, DEFINITION);
  const { dir, store } = await scratchStore();

  await writeFile(
    join(dir, 'jobs.job.job_search.json'),
    `{\n\n    "mappings":   {\n  "dynamic": false,\n"fields": {\n"title": {"type":"string","analyzer":"lucene.english"}\n}\n}\n}\n`,
  );

  const plan = await planCluster(atlas, await store.load(), new SchemaValidator());
  assert.deepEqual(plan.changes, []);
});

test('omitting a field that Atlas defaults is not a change', async () => {
  const atlas = new FakeAtlas('acme-prod');
  // Atlas will report analyzer/searchAnalyzer/numPartitions/storedSource back.
  atlas.seed(KEY, { mappings: { dynamic: true } });
  const { dir, store } = await scratchStore();

  await writeFile(join(dir, 'jobs.job.job_search.json'), JSON.stringify({ mappings: { dynamic: true } }));

  const plan = await planCluster(atlas, await store.load(), new SchemaValidator());
  assert.deepEqual(plan.changes, []);
});

test('a real field change is still reported, with the path and both values', async () => {
  const atlas = new FakeAtlas('acme-prod');
  atlas.seed(KEY, DEFINITION);
  const { dir, store } = await scratchStore();

  await writeFile(
    join(dir, 'jobs.job.job_search.json'),
    JSON.stringify({
      mappings: { dynamic: false, fields: { title: { type: 'string', analyzer: 'lucene.standard' } } },
    }),
  );

  const plan = await planCluster(atlas, await store.load(), new SchemaValidator());
  assert.equal(plan.changes.length, 1);
  const change = plan.changes[0]!;
  assert.equal(change.kind, 'update');
  assert.deepEqual(change.fields, [
    {
      path: 'mappings.fields.title.analyzer',
      deployed: 'lucene.english',
      local: 'lucene.standard',
      certainty: 'certain',
    },
  ]);
});
