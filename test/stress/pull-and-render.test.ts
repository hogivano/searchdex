import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pullCluster } from '../../src/application/pull.ts';
import { runPull } from '../../src/presentation/commands/pull.ts';
import { computePlan } from '../../src/domain/diff.ts';
import { SearchdexError } from '../../src/domain/index.ts';
import type { DeployedIndex, LocalIndex } from '../../src/domain/index.ts';
import { renderApply, renderClusterTable, renderFailures, renderPlan } from '../../src/presentation/render/human.ts';
import { applyToJson, clusterOutcomesToJson, planToJson } from '../../src/presentation/render/json.ts';
import { captureOut, testContext } from '../fixtures/context.ts';
import { FakeAtlas } from '../fixtures/fake-atlas.ts';

const KEY = { database: 'jobs', collection: 'job', name: 'job_search' };

test('pull skips vectorSearch by default and says so', async () => {
  const atlas = new FakeAtlas('prod');
  atlas.seed(KEY, { mappings: { dynamic: true } });
  atlas.seed({ ...KEY, name: 'vec' }, { fields: [] }, 'vectorSearch');
  const context = await testContext(['prod']);

  const result = await pullCluster(atlas, context.store, { includeVectorSearch: false });

  assert.equal(result.files.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!.reason, /not managed in v0/);
});

test('pull --include-vector-search writes them with their type', async () => {
  const atlas = new FakeAtlas('prod');
  atlas.seed({ ...KEY, name: 'vec' }, { fields: [{ type: 'vector', path: 'e', numDimensions: 3 }] }, 'vectorSearch');
  const context = await testContext(['prod']);

  const result = await pullCluster(atlas, context.store, { includeVectorSearch: true });
  const written = JSON.parse(await readFile(result.files[0]!, 'utf8')) as { type?: string };

  assert.equal(written.type, 'vectorSearch', 'the type must survive, or the next apply changes it');
  const [reloaded] = await context.store.load();
  assert.equal(reloaded?.type, 'vectorSearch');
});

test('pull from an empty cluster writes nothing and still succeeds', async () => {
  const context = await testContext(['prod']);
  const io = captureOut();

  const code = await runPull(context, { includeVectorSearch: false }, io.out);

  assert.equal(code, 0);
  assert.match(io.text(), /0 definitions written/);
});

test('pull refuses to guess which of several clusters the repo describes', async () => {
  const context = await testContext(['eu', 'us']);

  await assert.rejects(() => runPull(context, { includeVectorSearch: false }, captureOut().out), (error: unknown) => {
    assert.ok(error instanceof SearchdexError);
    assert.match(error.message, /one cluster at a time/);
    assert.match(error.details.join(' '), /eu, us/);
    return true;
  });
});

test('pull reports a name it cannot store on disk instead of writing the wrong file', async () => {
  const atlas = new FakeAtlas('prod');
  atlas.seed({ database: 'jobs.v2', collection: 'job', name: 'search' }, { mappings: {} });
  const context = await testContext(['prod']);

  await assert.rejects(
    () => pullCluster(atlas, context.store, { includeVectorSearch: false }),
    /database contains a "\."/,
  );
});

/* --- renderers ------------------------------------------------------------ */

function deployed(name: string, definition: Record<string, unknown>): DeployedIndex {
  return {
    key: { ...KEY, name },
    type: 'search',
    definition: definition as never,
    indexID: '0'.repeat(24),
    status: 'READY',
    queryable: true,
    definitionVersion: 1,
    hosts: [],
  };
}

function local(name: string, definition: Record<string, unknown>): LocalIndex {
  return { key: { ...KEY, name }, type: 'search', definition: definition as never, source: `${name}.json` };
}

test('the human diff shows both values and the path for every changed field', () => {
  const plan = computePlan(
    'prod',
    [local('a', { analyzer: 'lucene.english' }), local('b', {})],
    [deployed('a', { analyzer: 'lucene.keyword' }), deployed('c', {})],
  );
  const text = renderPlan(plan);

  assert.match(text, /~ jobs\.job\.a/);
  assert.match(text, /deployed {2}lucene\.keyword/);
  assert.match(text, /local {5}lucene\.english/);
  assert.match(text, /\+ jobs\.job\.b\s+new index/);
  assert.match(text, /- jobs\.job\.c\s+exists remotely, not in repo/);
  assert.match(text, /3 changes on prod/);
});

test('a very long index name does not corrupt the column layout', () => {
  const name = 'a'.repeat(120);
  const plan = computePlan('prod', [local(name, {})], []);
  const lines = renderPlan(plan).split('\n').filter((line) => line.includes(name));

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /new index$/, 'the description was pushed off the line');
});

test('object and array values render as JSON rather than [object Object]', () => {
  const plan = computePlan(
    'prod',
    [local('a', { analyzers: [{ name: 'x' }] })],
    [deployed('a', { analyzers: [{ name: 'y' }] })],
  );
  const text = renderPlan(plan);

  assert.equal(text.includes('[object Object]'), false);
  assert.match(text, /\[\{"name":"x"\}\]/);
});

test('an absent value renders as (absent), not as undefined', () => {
  const plan = computePlan('prod', [local('a', {})], [deployed('a', { mystery: 1 })]);
  const text = renderPlan(plan);

  assert.match(text, /\(absent\)/);
  assert.equal(text.includes('undefined'), false);
});

test('failures render whether there is one cluster or several', () => {
  const outcomes = [
    { cluster: 'eu', status: 'ok' as const, value: 1 },
    { cluster: 'us', status: 'failed' as const, error: new Error('Atlas API 403') },
  ];

  assert.match(renderFailures(outcomes), /us: Atlas API 403/);
  assert.equal(renderFailures([outcomes[0]!]), '', 'printed a failure section with no failures');

  const table = renderClusterTable(outcomes);
  assert.match(table, /eu\s+ok/);
  assert.match(table, /us\s+failed: Atlas API 403/);
});

test('apply output distinguishes live, accepted, skipped and failed', () => {
  const plan = computePlan('prod', [local('a', {}), local('b', {}), local('c', {})], [deployed('d', {})]);
  const byName = (name: string) => plan.changes.find((change) => change.key.name === name)!;

  const text = renderApply({
    cluster: 'prod',
    outcomes: [
      { kind: 'applied', change: byName('a'), waitedMs: 31_200, note: undefined },
      { kind: 'accepted', change: byName('b') },
      { kind: 'skipped', change: byName('d'), reason: 'deleting requires --allow-delete' },
      { kind: 'failed', change: byName('c'), error: new Error('Atlas API 400: DUPLICATE') },
    ],
  });

  assert.match(text, /live after 31\.2s/);
  assert.match(text, /accepted by Atlas \(not waiting\)/);
  assert.match(text, /skipped: deleting requires --allow-delete/);
  assert.match(text, /! jobs\.job\.c\s+Atlas API 400: DUPLICATE/);
});

test('every JSON renderer emits valid JSON with no undefined', () => {
  const plan = computePlan('prod', [local('a', {})], [deployed('b', { x: 1 })]);

  for (const value of [
    planToJson(plan),
    applyToJson({ cluster: 'prod', outcomes: [{ kind: 'accepted', change: plan.changes[0]! }] }),
    clusterOutcomesToJson(
      [
        { cluster: 'eu', status: 'ok', value: plan },
        { cluster: 'us', status: 'failed', error: new Error('boom') },
        { cluster: 'ap', status: 'skipped', reason: 'already completed in a previous run' },
      ],
      planToJson,
    ),
  ]) {
    const text = JSON.stringify(value);
    assert.doesNotThrow(() => JSON.parse(text));
    assert.equal(text.includes('undefined'), false, `undefined leaked into ${text.slice(0, 80)}`);
  }
});
