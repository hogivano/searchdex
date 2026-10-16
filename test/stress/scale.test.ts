import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { planCluster } from '../../src/application/plan-cluster.ts';
import { applyPlan } from '../../src/application/apply.ts';
import { pullCluster } from '../../src/application/pull.ts';
import { silentReporter } from '../../src/application/ports.ts';
import { permissiveValidator, SchemaValidator } from '../../src/infrastructure/validation/schema-validator.ts';
import { renderPlan } from '../../src/presentation/render/human.ts';
import { planToJson } from '../../src/presentation/render/json.ts';
import { runDiff } from '../../src/presentation/commands/diff.ts';
import { EXIT } from '../../src/presentation/exit-codes.ts';
import { captureOut, testContext } from '../fixtures/context.ts';
import { fakeClock, FakeAtlas } from '../fixtures/fake-atlas.ts';

/**
 * Sizes a real deployment reaches: hundreds of indexes on a cluster, dozens of
 * clusters in a fan-out. Nothing here should be quadratic, and nothing should
 * hold every response in memory twice.
 */

const APPLY = { allowDelete: true, wait: false, timeoutMs: 60_000, pollIntervalMs: 1_000 };

function definition(i: number) {
  return {
    mappings: {
      dynamic: false,
      fields: {
        title: { type: 'string', analyzer: i % 2 === 0 ? 'lucene.english' : 'lucene.standard' },
        body: { type: 'string' },
        tags: { type: 'string', analyzer: 'lucene.keyword' },
      },
    },
  };
}

test('500 indexes: plan, apply and re-plan stay linear', async () => {
  const atlas = new FakeAtlas('big');
  const local = Array.from({ length: 500 }, (_, i) => ({
    key: { database: 'jobs', collection: `coll_${i % 20}`, name: `index_${i}` },
    type: 'search' as const,
    definition: definition(i) as never,
    source: `search-indexes/jobs.coll_${i % 20}.index_${i}.json`,
  }));

  const startedAt = performance.now();
  const plan = await planCluster(atlas, local, permissiveValidator);
  assert.equal(plan.changes.length, 500);

  const result = await applyPlan(atlas, plan, APPLY, fakeClock(), silentReporter);
  assert.equal(result.outcomes.filter((outcome) => outcome.kind === 'accepted').length, 500);

  const after = await planCluster(atlas, local, permissiveValidator);
  const elapsed = performance.now() - startedAt;

  assert.deepEqual(after.changes, [], 'a 500-index apply did not converge');
  assert.equal(after.unchanged.length, 500);
  assert.ok(elapsed < 5_000, `500 indexes took ${elapsed.toFixed(0)}ms`);
});

test('500 indexes render without truncating or crashing either output', async () => {
  const atlas = new FakeAtlas('big');
  const local = Array.from({ length: 500 }, (_, i) => ({
    key: { database: 'jobs', collection: 'job', name: `index_${i}` },
    type: 'search' as const,
    definition: definition(i) as never,
    source: `x_${i}`,
  }));
  const plan = await planCluster(atlas, local, permissiveValidator);

  const human = renderPlan(plan);
  assert.equal(human.split('\n').filter((line) => line.includes('new index')).length, 500);

  const json = planToJson(plan);
  assert.equal(JSON.parse(JSON.stringify(json)).changes.length, 500);
});

test('40 clusters fan out under the concurrency bound and all report', async () => {
  const names = Array.from({ length: 40 }, (_, i) => `cluster-${String(i).padStart(2, '0')}`);
  const context = await testContext(names, { concurrency: 4 });
  await writeFile(join(context.dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');

  const io = captureOut();
  const code = await runDiff(context, { failOnChanges: true }, io.out);

  assert.equal(code, EXIT.CHANGES);
  for (const name of names) {
    assert.match(io.text(), new RegExp(`cluster: ${name}\\b`), `${name} missing from the report`);
  }
});

test('pull writes every index, and the round trip is clean at scale', async () => {
  const atlas = new FakeAtlas('big');
  for (let i = 0; i < 200; i += 1) {
    atlas.seed({ database: 'jobs', collection: 'job', name: `index_${i}` }, definition(i) as never);
  }

  const context = await testContext(['big']);
  const result = await pullCluster(atlas, context.store, { includeVectorSearch: false });
  assert.equal(result.files.length, 200);

  const plan = await planCluster(atlas, await context.store.load(), new SchemaValidator());
  assert.deepEqual(plan.changes, [], 'pull at scale produced false drift');
});

test('a deeply nested definition survives the full round trip', async () => {
  const atlas = new FakeAtlas('deep');
  let nested: Record<string, unknown> = { type: 'string', analyzer: 'lucene.english' };
  for (let i = 0; i < 40; i += 1) {
    nested = { type: 'document', dynamic: false, fields: { [`level_${i}`]: nested } };
  }

  const local = [{
    key: { database: 'jobs', collection: 'job', name: 'deep' },
    type: 'search' as const,
    definition: { mappings: { dynamic: false, fields: { root: nested } } } as never,
    source: 'deep.json',
  }];

  const plan = await planCluster(atlas, local, permissiveValidator);
  await applyPlan(atlas, plan, APPLY, fakeClock(), silentReporter);

  assert.deepEqual((await planCluster(atlas, local, permissiveValidator)).changes, []);
});

test('unicode and awkward characters survive namespaces and definitions', async () => {
  const atlas = new FakeAtlas('unicode');
  const local = [{
    key: { database: 'jobs', collection: 'job', name: 'índice_búsqueda' },
    type: 'search' as const,
    definition: { mappings: { dynamic: false, fields: { 'título': { type: 'string' }, '本文': { type: 'string' } } } } as never,
    source: 'unicode.json',
  }];

  const plan = await planCluster(atlas, local, permissiveValidator);
  await applyPlan(atlas, plan, APPLY, fakeClock(), silentReporter);

  assert.deepEqual((await planCluster(atlas, local, permissiveValidator)).changes, []);
  assert.match(renderPlan(plan), /índice_búsqueda/);
});
