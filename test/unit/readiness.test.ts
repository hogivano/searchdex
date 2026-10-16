import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess } from '../../src/domain/readiness.ts';
import type { DeployedIndex, HostStatus, IndexStatus } from '../../src/domain/index.ts';

/**
 * The flagship behaviour, tested at the level where it is decided.
 *
 * The case that matters most is the third one: an index that reports READY and
 * queryable while still serving the *previous* definition. Any check that stops
 * at the status field calls that done, and a deploy pipeline built on it lies.
 */

function index(overrides: Partial<DeployedIndex> = {}): DeployedIndex {
  return {
    key: { database: 'jobs', collection: 'job', name: 'job_search' },
    type: 'search',
    definition: {},
    indexID: 'abc',
    status: 'READY',
    queryable: true,
    definitionVersion: 2,
    hosts: [],
    ...overrides,
  };
}

function host(status: IndexStatus, servingVersion: number | undefined, queryable = true): HostStatus {
  return { hostname: `host-${servingVersion ?? 'x'}`, status, queryable, servingVersion };
}

test('READY and queryable with no per-host detail is ready, and says why it is unsure', () => {
  const result = assess(index());
  assert.equal(result.state, 'ready');
  assert.match(result.state === 'ready' ? (result.note ?? '') : '', /no per-host detail/);
});

test('BUILDING is not ready even when Atlas reports it queryable', () => {
  const result = assess(index({ status: 'BUILDING', queryable: true }));
  assert.equal(result.state, 'building');
});

test('READY while a host still serves the previous definition is NOT ready', () => {
  const result = assess(
    index({ hosts: [host('READY', 2), host('READY', 1)] }),
    2,
  );
  assert.equal(result.state, 'building');
  assert.match(result.state === 'building' ? result.detail : '', /1 of 2 hosts still serving an older definition/);
});

test('ready once every host serves the pushed version', () => {
  const result = assess(index({ hosts: [host('READY', 2), host('READY', 2)] }), 2);
  assert.equal(result.state, 'ready');
});

test('a host with no version reported is not treated as behind', () => {
  const result = assess(index({ hosts: [host('READY', undefined)] }), 2);
  assert.equal(result.state, 'ready');
});

test('a non-queryable host keeps the index building', () => {
  const result = assess(index({ hosts: [host('READY', 2), host('BUILDING', 2, false)] }), 2);
  assert.equal(result.state, 'building');
});

test('STALE is ready but carries a warning', () => {
  const result = assess(index({ status: 'STALE', hosts: [host('STALE', 2)] }), 2);
  assert.equal(result.state, 'ready');
  assert.match(result.state === 'ready' ? (result.note ?? '') : '', /STALE/);
});

test('FAILED names the hosts that failed', () => {
  const result = assess(index({ status: 'FAILED', hosts: [host('FAILED', 1)] }));
  assert.equal(result.state, 'failed');
  assert.match(result.state === 'failed' ? result.detail : '', /host-1/);
});

test('DOES_NOT_EXIST is distinct from failed', () => {
  assert.equal(assess(index({ status: 'DOES_NOT_EXIST' })).state, 'gone');
});
