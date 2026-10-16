import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, canonicalString, definitionsEqual } from '../../src/domain/normalize.ts';
import { diffDefinitions } from '../../src/domain/diff.ts';
import type { Json, JsonObject } from '../../src/domain/index.ts';

/**
 * Normalisation decides every answer the tool gives, so its invariants are
 * asserted over generated input rather than over the handful of shapes a human
 * thinks to write down.
 *
 * The three that matter:
 *   idempotent  — canonicalising twice changes nothing
 *   stable      — key order in the input never changes the output
 *   faithful    — a value that is not a documented default always survives
 */

/** Deterministic PRNG: a failing seed can be replayed instead of being a ghost. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const SCALARS: Json[] = [
  0, 1, -1, 1.5, 255, true, false, null, '', 'lucene.standard', 'lucene.english',
  'offsets', 'string', 'document', '✓ unicode ✓', 'a"quoted"key', '  padded  ',
];

function randomJson(random: () => number, depth = 0): Json {
  const roll = random();
  if (depth > 4 || roll < 0.45) return SCALARS[Math.floor(random() * SCALARS.length)]!;
  if (roll < 0.6) {
    return Array.from({ length: Math.floor(random() * 4) }, () => randomJson(random, depth + 1));
  }
  const keys = ['type', 'analyzer', 'store', 'norms', 'indexOptions', 'fields', 'dynamic', 'weird key', 'zz'];
  const object: JsonObject = {};
  for (let i = 0; i < Math.floor(random() * 5); i += 1) {
    object[keys[Math.floor(random() * keys.length)]!] = randomJson(random, depth + 1);
  }
  return object;
}

/** Always an object, so every seed exercises the code rather than being skipped. */
function randomDefinition(random: () => number): JsonObject {
  const keys = ['type', 'analyzer', 'store', 'norms', 'indexOptions', 'mappings', 'fields', 'dynamic', 'weird key'];
  const object: JsonObject = {};
  const size = 1 + Math.floor(random() * 5);
  for (let i = 0; i < size; i += 1) {
    object[keys[Math.floor(random() * keys.length)]!] = randomJson(random, 1);
  }
  return object;
}

/** Rebuilds an equal object with its keys inserted in a different order. */
function shuffleKeys(value: Json, random: () => number): Json {
  if (Array.isArray(value)) return value.map((item) => shuffleKeys(item, random));
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [entries[i], entries[j]] = [entries[j]!, entries[i]!];
  }
  return Object.fromEntries(entries.map(([key, child]) => [key, shuffleKeys(child as Json, random)]));
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

test('canonicalize is idempotent', () => {
  for (const seed of SEEDS) {
    const definition = randomDefinition(rng(seed));
    const once = canonicalize(definition);
    const twice = canonicalize(once);
    assert.deepEqual(twice, once, `not idempotent for seed ${seed}`);
  }
});

test('key order never changes the canonical form', () => {
  for (const seed of SEEDS) {
    const definition = randomDefinition(rng(seed));
    const shuffled = shuffleKeys(definition, rng(seed + 9999)) as JsonObject;
    assert.equal(
      canonicalString(shuffled),
      canonicalString(definition),
      `key order changed the result for seed ${seed}`,
    );
  }
});

test('a definition always equals itself, however odd', () => {
  for (const seed of SEEDS) {
    const definition = randomDefinition(rng(seed));
    assert.equal(definitionsEqual(definition, definition), true, `seed ${seed} did not equal itself`);
    assert.deepEqual(diffDefinitions(definition, definition), [], `seed ${seed} diffed against itself`);
  }
});

test('changing any leaf value produces a diff — normalisation never hides a change', () => {
  let exercised = 0;
  for (const seed of SEEDS) {
    const definition = randomDefinition(rng(seed));
    const canonical = canonicalize(definition);
    const paths = leafPaths(canonical).filter((path) => path.length > 0);
    if (paths.length === 0) continue;
    exercised += 1;

    const target = paths[Math.floor(rng(seed + 4242)() * paths.length)]!;
    const mutated = setAt(canonical, target, '__searchdex_sentinel__');

    assert.notDeepEqual(
      diffDefinitions(canonical, mutated),
      [],
      `changing ${target.join('.')} was invisible for seed ${seed}`,
    );
  }
  // Guards against the generator quietly producing nothing worth testing.
  assert.ok(exercised > SEEDS.length / 2, `only ${exercised} of ${SEEDS.length} seeds had a leaf to mutate`);
});

test('array order is never normalised away', () => {
  const withArray = { analyzers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  const reordered = { analyzers: [{ name: 'c' }, { name: 'b' }, { name: 'a' }] };
  assert.equal(definitionsEqual(withArray as never, reordered as never), false);
});

test('null is a value, not an absence', () => {
  assert.equal(definitionsEqual({ analyzer: null } as never, {} as never), false);
  assert.deepEqual(canonicalize({ analyzer: null } as never), { analyzer: null });
});

test('a key that collides with a default name at the wrong depth is left alone', () => {
  // `store` is a default only on a field whose type is `string`.
  const canonical = canonicalize({ store: true, mappings: { fields: { a: { type: 'date', store: true } } } } as never);
  assert.deepEqual(canonical, {
    store: true,
    mappings: { fields: { a: { type: 'date', store: true } } },
  });
});

test('deep nesting does not blow the stack', () => {
  let deep: Json = { type: 'string', store: true };
  for (let i = 0; i < 500; i += 1) deep = { type: 'document', fields: { nested: deep } };
  assert.doesNotThrow(() => canonicalize(deep as JsonObject));
});

test('a large definition canonicalises in reasonable time', () => {
  const fields: JsonObject = {};
  for (let i = 0; i < 5_000; i += 1) {
    fields[`field_${i}`] = { type: 'string', analyzer: 'lucene.english', store: true, norms: 'include' };
  }
  const definition = { mappings: { dynamic: false, fields } };

  const startedAt = performance.now();
  const canonical = canonicalize(definition as never);
  const elapsed = performance.now() - startedAt;

  assert.equal(Object.keys((canonical['mappings'] as JsonObject)['fields'] as JsonObject).length, 5_000);
  assert.ok(elapsed < 3_000, `canonicalising 5000 fields took ${elapsed.toFixed(0)}ms`);
});

function leafPaths(value: Json, prefix: string[] = []): string[][] {
  if (typeof value !== 'object' || value === null) return [prefix];
  if (Array.isArray(value)) return value.flatMap((item, i) => leafPaths(item, [...prefix, String(i)]));
  const entries = Object.entries(value);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([key, child]) => leafPaths(child as Json, [...prefix, key]));
}

function setAt(value: Json, path: readonly string[], replacement: Json): JsonObject {
  const clone = structuredClone(value) as JsonObject;
  if (path.length === 0) return clone;
  let cursor: Json = clone;
  for (const segment of path.slice(0, -1)) {
    cursor = (cursor as JsonObject)[segment] as Json;
  }
  (cursor as JsonObject)[path[path.length - 1]!] = replacement;
  return clone;
}
