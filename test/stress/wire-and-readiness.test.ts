import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toDeployedIndex, toCreateRequest, toUpdateRequest } from '../../src/infrastructure/atlas/wire.ts';
import { assess } from '../../src/domain/readiness.ts';
import { waitForDeleted, waitForReady } from '../../src/application/wait-for-ready.ts';
import { silentReporter } from '../../src/application/ports.ts';
import type { SearchIndexGateway } from '../../src/application/ports.ts';
import type { DeployedIndex, IndexKey, LocalIndex } from '../../src/domain/index.ts';
import { IndexBuildFailedError, ReadinessTimeoutError } from '../../src/domain/index.ts';
import { fakeClock } from '../fixtures/fake-atlas.ts';

/**
 * The wire mapper is the tool's only contact with Atlas' response shape, and
 * readiness is computed entirely from what it produces. Both are exercised here
 * against the awkward shapes: fields missing, unknown enum values, the legacy
 * resource, and a real three-host replica set mid-rollout.
 */

const KEY: IndexKey = { database: 'jobs', collection: 'job', name: 'job_search' };

test('a complete response maps to the domain model', () => {
  const index = toDeployedIndex({
    database: 'jobs',
    collectionName: 'job',
    name: 'job_search',
    type: 'search',
    indexID: '0'.repeat(24),
    status: 'READY',
    queryable: true,
    latestDefinition: { mappings: { dynamic: true } },
    latestDefinitionVersion: { version: 7, createdAt: '2026-09-09T00:00:00Z' },
    statusDetail: [
      { hostname: 'h0', status: 'READY', queryable: true, mainIndex: { definitionVersion: { version: 7 } } },
    ],
  });

  assert.deepEqual(index?.key, KEY);
  assert.equal(index?.definitionVersion, 7);
  assert.equal(index?.hosts[0]?.servingVersion, 7);
});

test('a response missing its namespace is dropped rather than half-mapped', () => {
  for (const raw of [
    {},
    { database: 'jobs' },
    { database: 'jobs', collectionName: 'job' },
    null,
    'not an object',
    [1, 2, 3],
  ]) {
    assert.equal(toDeployedIndex(raw as never), undefined, `mapped ${JSON.stringify(raw)}`);
  }
});

test('missing optional fields degrade instead of throwing', () => {
  const index = toDeployedIndex({ database: 'jobs', collectionName: 'job', name: 'job_search' });

  assert.equal(index?.status, 'UNKNOWN');
  assert.equal(index?.queryable, false);
  assert.equal(index?.definitionVersion, undefined);
  assert.deepEqual(index?.definition, {});
  assert.deepEqual(index?.hosts, []);
  assert.equal(index?.type, 'search');
});

test('legacy 2023-01-01 statuses map to their modern equivalents', () => {
  const cases: Record<string, string> = {
    NOT_STARTED: 'PENDING',
    IN_PROGRESS: 'BUILDING',
    STEADY: 'READY',
    MIGRATING: 'BUILDING',
    PAUSED: 'PENDING',
  };
  for (const [legacy, expected] of Object.entries(cases)) {
    const index = toDeployedIndex({ database: 'd', collectionName: 'c', name: 'n', status: legacy });
    assert.equal(index?.status, expected, `${legacy} mapped to ${index?.status}`);
  }
});

test('an unrecognised status degrades to UNKNOWN rather than crashing the CLI', () => {
  const index = toDeployedIndex({ database: 'd', collectionName: 'c', name: 'n', status: 'SOMETHING_NEW' });
  assert.equal(index?.status, 'UNKNOWN');
});

test('an unrecognised status is accepted as ready only with a note saying so', () => {
  // A future Atlas status must not deadlock every apply, but the user has to be
  // told that the usual signal was not available.
  const readiness = assess({ ...toDeployedIndex({
    database: 'd', collectionName: 'c', name: 'n', status: 'SOMETHING_NEW',
  })!, queryable: true });

  assert.equal(readiness.state, 'ready');
  assert.match(readiness.state === 'ready' ? (readiness.note ?? '') : '', /does not recognise/);
});

test('a STALE index reports both its notes when host detail is missing too', () => {
  const readiness = assess({ ...replicaSet([], 'STALE'), hosts: [], status: 'STALE' });
  assert.equal(readiness.state, 'ready');
  const note = readiness.state === 'ready' ? (readiness.note ?? '') : '';
  assert.match(note, /no per-host detail/);
  assert.match(note, /STALE/);
});

test('the create body carries the namespace outside the definition', () => {
  const local: LocalIndex = { key: KEY, type: 'search', definition: { mappings: {} }, source: 'x' };
  assert.deepEqual(toCreateRequest(local), {
    database: 'jobs',
    collectionName: 'job',
    name: 'job_search',
    type: 'search',
    definition: { mappings: {} },
  });
  // Update takes the definition alone; sending the namespace is a 400.
  assert.deepEqual(toUpdateRequest(local), { definition: { mappings: {} } });
});

/** A three-host replica set rolling a new definition, one host at a time. */
function replicaSet(versions: readonly (number | undefined)[], status = 'READY'): DeployedIndex {
  return {
    key: KEY,
    type: 'search',
    definition: {},
    indexID: 'abc',
    status: status as DeployedIndex['status'],
    queryable: true,
    definitionVersion: 3,
    hosts: versions.map((version, i) => ({
      hostname: `atlas-shard-00-0${i}.mongodb.net`,
      status: status as DeployedIndex['status'],
      queryable: true,
      servingVersion: version,
    })),
  };
}

test('a rollout is not ready until the last host catches up', () => {
  assert.equal(assess(replicaSet([2, 2, 2]), 3).state, 'building');
  assert.equal(assess(replicaSet([3, 2, 2]), 3).state, 'building');
  assert.equal(assess(replicaSet([3, 3, 2]), 3).state, 'building');
  assert.equal(assess(replicaSet([3, 3, 3]), 3).state, 'ready');
});

test('the building message names how many hosts are behind and which', () => {
  const readiness = assess(replicaSet([3, 2, 2]), 3);
  assert.equal(readiness.state, 'building');
  const detail = readiness.state === 'building' ? readiness.detail : '';
  assert.match(detail, /2 of 3 hosts/);
  assert.match(detail, /atlas-shard-00-01/);
});

test('a host ahead of the target is not treated as behind', () => {
  // Someone else applied a newer definition mid-wait; ours is live everywhere.
  assert.equal(assess(replicaSet([4, 4, 4]), 3).state, 'ready');
});

test('waitForReady polls until every host serves the pushed version', async () => {
  const rollout = [replicaSet([2, 2, 2]), replicaSet([3, 2, 2]), replicaSet([3, 3, 2]), replicaSet([3, 3, 3])];
  let poll = 0;
  const gateway = stubGateway(async () => rollout[Math.min(poll++, rollout.length - 1)]!);

  const result = await waitForReady(
    gateway,
    KEY,
    { timeoutMs: 60_000, pollIntervalMs: 1_000, targetVersion: 3 },
    fakeClock(),
    silentReporter,
  );

  assert.equal(poll, 4, `stopped after ${poll} polls`);
  assert.equal(result.note, undefined);
});

test('waitForReady reports a FAILED build immediately, without waiting out the timeout', async () => {
  const gateway = stubGateway(async () => ({ ...replicaSet([2, 2, 2]), status: 'FAILED' as const }));
  const clock = fakeClock();

  await assert.rejects(
    () => waitForReady(gateway, KEY, { timeoutMs: 600_000, pollIntervalMs: 1_000 }, clock, silentReporter),
    IndexBuildFailedError,
  );
  assert.equal(clock.elapsed, 0, 'waited before reporting a failure');
});

test('waitForReady times out with a message that does not read as a failed apply', async () => {
  const gateway = stubGateway(async () => replicaSet([2, 2, 2]));

  await assert.rejects(
    () => waitForReady(gateway, KEY, { timeoutMs: 5_000, pollIntervalMs: 1_000, targetVersion: 3 }, fakeClock(), silentReporter),
    (error: unknown) => {
      assert.ok(error instanceof ReadinessTimeoutError);
      assert.match(error.details.join(' '), /still building/);
      assert.match(error.details.join(' '), /apply itself succeeded/);
      return true;
    },
  );
});

test('an index vanishing mid-wait is a failure, not a silent success', async () => {
  const gateway = stubGateway(async () => undefined);
  await assert.rejects(
    () => waitForReady(gateway, KEY, { timeoutMs: 5_000, pollIntervalMs: 1_000 }, fakeClock(), silentReporter),
    IndexBuildFailedError,
  );
});

test('waitForDeleted returns once the index is gone, and times out if it lingers', async () => {
  let polls = 0;
  const vanishing = stubGateway(async () => (polls++ < 2 ? replicaSet([3, 3, 3]) : undefined));
  await waitForDeleted(vanishing, KEY, { timeoutMs: 60_000, pollIntervalMs: 1_000 }, fakeClock());
  assert.equal(polls, 3);

  const stuck = stubGateway(async () => ({ ...replicaSet([3, 3, 3]), status: 'DELETING' as const }));
  await assert.rejects(
    () => waitForDeleted(stuck, KEY, { timeoutMs: 3_000, pollIntervalMs: 1_000 }, fakeClock()),
    ReadinessTimeoutError,
  );
});

test('DOES_NOT_EXIST also satisfies waitForDeleted', async () => {
  const gateway = stubGateway(async () => ({ ...replicaSet([3, 3, 3]), status: 'DOES_NOT_EXIST' as const }));
  await waitForDeleted(gateway, KEY, { timeoutMs: 3_000, pollIntervalMs: 1_000 }, fakeClock());
});

function stubGateway(get: () => Promise<DeployedIndex | undefined>): SearchIndexGateway {
  return {
    cluster: 'test',
    get: async () => get(),
    list: async () => [],
    create: async () => ({ definitionVersion: undefined }),
    update: async () => ({ definitionVersion: undefined }),
    delete: async () => {},
  };
}
