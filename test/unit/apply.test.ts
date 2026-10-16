import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPlan } from '../../src/application/apply.ts';
import { planCluster } from '../../src/application/plan-cluster.ts';
import { silentReporter } from '../../src/application/ports.ts';
import { permissiveValidator } from '../../src/infrastructure/validation/schema-validator.ts';
import type { LocalIndex } from '../../src/domain/index.ts';
import { ReadinessTimeoutError, IndexBuildFailedError } from '../../src/domain/index.ts';
import { fakeClock, FakeAtlas } from '../fixtures/fake-atlas.ts';

const KEY = { database: 'jobs', collection: 'job', name: 'job_search' };

function local(definition: Record<string, unknown>): LocalIndex {
  return { key: KEY, type: 'search', definition: definition as never, source: 'test' };
}

const OPTIONS = { allowDelete: false, wait: true, timeoutMs: 60_000, pollIntervalMs: 1_000 };

test('apply waits for a create to become queryable before reporting it live', async () => {
  const atlas = new FakeAtlas('acme-prod', { buildPolls: 3 });
  const plan = await planCluster(atlas, [local({ mappings: { dynamic: true } })], permissiveValidator);
  const clock = fakeClock();

  const result = await applyPlan(atlas, plan, OPTIONS, clock, silentReporter);

  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]!.kind, 'applied');
  assert.ok(clock.elapsed > 0, 'returned without ever polling');
});

test('apply waits for an update until every host serves the new definition', async () => {
  const atlas = new FakeAtlas('acme-prod', { buildPolls: 2 });
  atlas.seed(KEY, { mappings: { dynamic: false, fields: { title: { type: 'string' } } } });

  const plan = await planCluster(
    atlas,
    [local({ mappings: { dynamic: false, fields: { title: { type: 'string', analyzer: 'lucene.english' } } } })],
    permissiveValidator,
  );
  assert.equal(plan.changes[0]!.kind, 'update');

  const result = await applyPlan(atlas, plan, OPTIONS, fakeClock(), silentReporter);
  assert.equal(result.outcomes[0]!.kind, 'applied');

  // The fake keeps serving the old version while building; if readiness were
  // based on status alone this would have returned after the first poll.
  const [deployed] = await atlas.list();
  assert.equal(deployed!.hosts.every((host) => host.servingVersion === 2), true);
});

test('--no-wait reports the change as accepted, not as live', async () => {
  const atlas = new FakeAtlas('acme-prod', { buildPolls: 5 });
  const plan = await planCluster(atlas, [local({ mappings: { dynamic: true } })], permissiveValidator);

  const result = await applyPlan(atlas, plan, { ...OPTIONS, wait: false }, fakeClock(), silentReporter);
  assert.equal(result.outcomes[0]!.kind, 'accepted');
});

test('a timeout is reported as still building, not as a failed apply', async () => {
  const atlas = new FakeAtlas('acme-prod', { buildPolls: 1000 });
  const plan = await planCluster(atlas, [local({ mappings: { dynamic: true } })], permissiveValidator);

  const result = await applyPlan(atlas, plan, { ...OPTIONS, timeoutMs: 5_000 }, fakeClock(), silentReporter);

  const outcome = result.outcomes[0]!;
  assert.equal(outcome.kind, 'failed');
  assert.ok(outcome.kind === 'failed' && outcome.error instanceof ReadinessTimeoutError);
  assert.match(outcome.error.message, /timed out waiting/);
  assert.match(
    (outcome.error as ReadinessTimeoutError).details.join(' '),
    /still building/,
    'the message must not read as a failed apply',
  );
});

test('a failed build is distinguished from a timeout', async () => {
  const atlas = new FakeAtlas('acme-prod', { buildPolls: 2, failBuild: true });
  const plan = await planCluster(atlas, [local({ mappings: { dynamic: true } })], permissiveValidator);

  const result = await applyPlan(atlas, plan, OPTIONS, fakeClock(), silentReporter);
  const outcome = result.outcomes[0]!;
  assert.ok(outcome.kind === 'failed' && outcome.error instanceof IndexBuildFailedError);
});

test('deletes are skipped unless --allow-delete', async () => {
  const atlas = new FakeAtlas('acme-prod');
  atlas.seed(KEY, { mappings: { dynamic: true } });

  const plan = await planCluster(atlas, [], permissiveValidator);
  assert.equal(plan.changes[0]!.kind, 'delete');

  const skipped = await applyPlan(atlas, plan, OPTIONS, fakeClock(), silentReporter);
  assert.equal(skipped.outcomes[0]!.kind, 'skipped');
  assert.equal((await atlas.list()).length, 1, 'index was deleted without --allow-delete');

  const allowed = await applyPlan(
    atlas,
    plan,
    { ...OPTIONS, allowDelete: true },
    fakeClock(),
    silentReporter,
  );
  assert.equal(allowed.outcomes[0]!.kind, 'applied');
  assert.equal((await atlas.list()).length, 0);
});

test('one failing index does not abandon the rest of the plan', async () => {
  const atlas = new FakeAtlas('acme-prod');
  const plan = await planCluster(
    atlas,
    [
      local({ mappings: { dynamic: true } }),
      { ...local({ mappings: { dynamic: true } }), key: { ...KEY, name: 'other' } },
    ],
    permissiveValidator,
  );

  // Make the first create fail, leaving the second to succeed.
  const original = atlas.create.bind(atlas);
  let first = true;
  atlas.create = async (index) => {
    if (first) {
      first = false;
      throw new Error('Atlas API 400: DUPLICATE_INDEX_NAME');
    }
    return original(index);
  };

  const result = await applyPlan(atlas, plan, OPTIONS, fakeClock(), silentReporter);
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.kind),
    ['failed', 'applied'],
  );
});
