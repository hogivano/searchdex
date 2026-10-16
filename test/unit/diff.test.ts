import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePlan, diffDefinitions } from '../../src/domain/diff.ts';
import { canonicalize } from '../../src/domain/normalize.ts';
import { countByKind, hasUnexplained } from '../../src/domain/plan.ts';
import type { DeployedIndex, LocalIndex } from '../../src/domain/index.ts';

function localIndex(name: string, definition: Record<string, unknown>): LocalIndex {
  return {
    key: { database: 'jobs', collection: 'job', name },
    type: 'search',
    definition: definition as never,
    source: `search-indexes/jobs.job.${name}.json`,
  };
}

function deployedIndex(name: string, definition: Record<string, unknown>): DeployedIndex {
  return {
    key: { database: 'jobs', collection: 'job', name },
    type: 'search',
    definition: definition as never,
    indexID: '0'.repeat(24),
    status: 'READY',
    queryable: true,
    definitionVersion: 1,
    hosts: [],
  };
}

test('classifies create, update and delete in one pass', () => {
  const plan = computePlan(
    'acme-prod',
    [localIndex('job_search', { analyzer: 'lucene.english' }), localIndex('mentor_search', {})],
    [
      deployedIndex('job_search', { analyzer: 'lucene.standard' }),
      deployedIndex('legacy_search', {}),
    ],
  );

  assert.deepEqual(countByKind(plan), { create: 1, update: 1, delete: 1 });
  // Changes are ordered by index identity, so a plan reads the same every run.
  assert.deepEqual(
    plan.changes.map((change) => `${change.kind} ${change.key.name}`),
    ['update job_search', 'delete legacy_search', 'create mentor_search'],
  );
});

test('reports the exact path of a nested change', () => {
  const fields = diffDefinitions(
    { mappings: { fields: { title: { type: 'string', analyzer: 'lucene.standard' } } } } as never,
    { mappings: { fields: { title: { type: 'string', analyzer: 'lucene.english' } } } } as never,
  );
  assert.deepEqual(fields, [
    {
      path: 'mappings.fields.title.analyzer',
      deployed: 'lucene.standard',
      local: 'lucene.english',
      certainty: 'certain',
    },
  ]);
});

test('a field present on one side only is reported as unexplained, not as certain drift', () => {
  const fields = diffDefinitions({ mappings: { fields: {} }, somethingNew: 3 } as never, {
    mappings: { fields: {} },
  } as never);

  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.certainty, 'unexplained');
  assert.equal(fields[0]!.path, 'somethingNew');
});

test('array element order is a real change — Lucene cares about it', () => {
  const fields = diffDefinitions(
    { analyzers: [{ name: 'a' }, { name: 'b' }] } as never,
    { analyzers: [{ name: 'b' }, { name: 'a' }] } as never,
  );
  // Reported as one change on the array, not as a per-element edit script: for a
  // reordered analyzer chain, "these two lists differ" is the readable answer.
  assert.equal(fields.length, 1);
  assert.equal(fields[0]!.path, 'analyzers');
  assert.equal(fields[0]!.certainty, 'certain');
});

test('an index type change is surfaced as a field change', () => {
  const plan = computePlan(
    'acme-prod',
    [{ ...localIndex('job_search', {}), type: 'vectorSearch' as const }],
    [deployedIndex('job_search', {})],
  );
  assert.equal(plan.changes[0]!.fields[0]!.path, 'type');
});

test('hasUnexplained flags a plan whose diff we could not fully account for', () => {
  const plan = computePlan(
    'acme-prod',
    [localIndex('job_search', {})],
    [deployedIndex('job_search', { mysteryField: true })],
  );
  assert.equal(hasUnexplained(plan), true);
});

test('canonicalize strips server-owned fields', () => {
  const canonical = canonicalize({
    indexID: '0'.repeat(24),
    status: 'READY',
    queryable: true,
    latestDefinitionVersion: { version: 4 },
    mappings: { dynamic: true },
  } as never);
  assert.deepEqual(canonical, { mappings: { dynamic: true } });
});
