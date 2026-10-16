import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { applyPlan } from '../../src/application/apply.ts';
import { planCluster } from '../../src/application/plan-cluster.ts';
import { pullCluster } from '../../src/application/pull.ts';
import { silentReporter } from '../../src/application/ports.ts';
import { systemClock } from '../../src/infrastructure/clock.ts';
import { SchemaValidator } from '../../src/infrastructure/validation/schema-validator.ts';
import { FileDefinitionStore } from '../../src/infrastructure/fs/file-definition-store.ts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriverSearchIndexGateway } from '../fixtures/driver-gateway.ts';
import { startAtlasLocal } from '../fixtures/atlas-local.ts';
import type { LocalAtlas } from '../fixtures/atlas-local.ts';

/**
 * The acceptance test that matters: a real index build in a real mongot,
 * and a real `$search` query proving the change is live — not a status field
 * claiming it is.
 *
 * Needs docker. Opt in with SEARCHDEX_E2E=1 (`npm run test:e2e`).
 */
const ENABLED = process.env['SEARCHDEX_E2E'] === '1';

const DB = 'jobs';
const COLLECTION = 'job';
const INDEX = 'job_search';
const KEY = { database: DB, collection: COLLECTION, name: INDEX };

const APPLY = { allowDelete: true, wait: true, timeoutMs: 180_000, pollIntervalMs: 2_000 };

describe('against a real local Atlas', { skip: ENABLED ? false : 'set SEARCHDEX_E2E=1' }, () => {
  let atlas: LocalAtlas;
  let client: MongoClient;
  let gateway: DriverSearchIndexGateway;
  let dir: string;
  let store: FileDefinitionStore;

  before(async () => {
    atlas = await startAtlasLocal();
    client = await MongoClient.connect(atlas.uri);
    await client.db(DB).collection(COLLECTION).insertMany([
      { title: 'running shoes', body: 'a pair of running shoes' },
      { title: 'walking boots', body: 'sturdy walking boots' },
    ]);
    gateway = new DriverSearchIndexGateway(client, DB);
    dir = await mkdtemp(join(tmpdir(), 'searchdex-e2e-'));
    store = new FileDefinitionStore(dir);
  });

  after(async () => {
    await client?.close();
    await atlas?.stop();
  });

  test('apply waits until a $search query actually returns results', async () => {
    await writeFile(
      join(dir, `${DB}.${COLLECTION}.${INDEX}.json`),
      JSON.stringify({
        mappings: { dynamic: false, fields: { title: { type: 'string', analyzer: 'lucene.standard' } } },
      }),
    );

    const plan = await planCluster(gateway, await store.load(), new SchemaValidator());
    assert.equal(plan.changes[0]?.kind, 'create');

    const result = await applyPlan(gateway, plan, APPLY, systemClock, silentReporter);
    assert.equal(result.outcomes[0]?.kind, 'applied', JSON.stringify(result.outcomes[0]));

    // The claim under test: when apply returns, queries work. No retry loop here
    // on purpose — a retry would hide exactly the bug this test exists to catch.
    const hits = await client
      .db(DB)
      .collection(COLLECTION)
      .aggregate([{ $search: { index: INDEX, text: { query: 'running', path: 'title' } } }])
      .toArray();

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.['title'], 'running shoes');
  });

  test('pull writes definitions that diff reports as unchanged', async () => {
    const pullDir = await mkdtemp(join(tmpdir(), 'searchdex-e2e-pull-'));
    const pullStore = new FileDefinitionStore(pullDir);

    await pullCluster(gateway, pullStore, { includeVectorSearch: false });
    const plan = await planCluster(gateway, await pullStore.load(), new SchemaValidator());

    assert.deepEqual(
      plan.changes,
      [],
      `round-tripping through pull produced false drift:\n${JSON.stringify(plan.changes, null, 2)}`,
    );
  });

  test('an out-of-band edit is detected as drift', async () => {
    await client.db(DB).collection(COLLECTION).updateSearchIndex(INDEX, {
      mappings: { dynamic: false, fields: { title: { type: 'string', analyzer: 'lucene.english' } } },
    });

    // The repo still says lucene.standard; wait for mongot to report the edit.
    const deadline = Date.now() + 120_000;
    for (;;) {
      const plan = await planCluster(gateway, await store.load(), new SchemaValidator());
      if (plan.changes.length > 0) {
        assert.equal(plan.changes[0]?.kind, 'update');
        assert.equal(plan.changes[0]?.fields[0]?.path, 'mappings.fields.title.analyzer');
        return;
      }
      assert.ok(Date.now() < deadline, 'drift was never detected');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  });

  test('apply converges the drift and the new analyzer takes effect', async () => {
    const plan = await planCluster(gateway, await store.load(), new SchemaValidator());
    const result = await applyPlan(gateway, plan, APPLY, systemClock, silentReporter);
    assert.equal(result.outcomes[0]?.kind, 'applied');

    const after = await planCluster(gateway, await store.load(), new SchemaValidator());
    assert.deepEqual(after.changes, []);
  });
});
