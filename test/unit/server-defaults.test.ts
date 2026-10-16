import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema } from '@mongodb-js/search-index-schema';
import { TYPE_DEFAULTS } from '../../src/domain/server-defaults.ts';
import { canonicalize } from '../../src/domain/normalize.ts';

/**
 * The defaults table is checked into the domain so it can be read and audited,
 * but it is not authored by hand. This test regenerates it from MongoDB's
 * published schemas and fails if the two have diverged — which is what will
 * happen the day `@mongodb-js/search-index-schema` adds a default and every
 * repo using searchdex starts seeing a phantom diff.
 *
 * If this fails, the fix is to update the table, not to loosen the test.
 */
test('TYPE_DEFAULTS matches @mongodb-js/search-index-schema', () => {
  assert.deepEqual(TYPE_DEFAULTS, extractTypeDefaults());
});

test('a string field carrying only server defaults canonicalises to nothing', () => {
  // Exactly what mongot returns for `{"type": "string"}`.
  const deployed = canonicalize({
    mappings: {
      dynamic: false,
      fields: {
        title: { type: 'string', indexOptions: 'offsets', store: true, norms: 'include' },
      },
    },
  } as never);

  assert.deepEqual(deployed, { mappings: { fields: { title: { type: 'string' } } } });
});

test('a non-default value on the same fields survives canonicalisation', () => {
  const deployed = canonicalize({
    mappings: { fields: { title: { type: 'string', store: false, norms: 'include' } } },
  } as never);

  assert.deepEqual(deployed, { mappings: { fields: { title: { type: 'string', store: false } } } });
});

test('defaults are applied by type, not by position, so nesting works', () => {
  const canonical = canonicalize({
    mappings: {
      fields: {
        author: {
          type: 'document',
          dynamic: false,
          fields: { name: { type: 'string', store: true } },
        },
      },
    },
  } as never);

  assert.deepEqual(canonical, {
    mappings: { fields: { author: { type: 'document', fields: { name: { type: 'string' } } } } },
  });
});

/** Mirrors the generator that produced src/domain/server-defaults.ts. */
function extractTypeDefaults(): Record<string, Record<string, unknown>> {
  const found: Record<string, Record<string, unknown>> = {};

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;

    const properties = (node as { properties?: Record<string, unknown> }).properties;
    if (properties && typeof properties === 'object') {
      const discriminator = properties['type'] as { const?: unknown } | undefined;
      if (typeof discriminator?.const === 'string') {
        for (const [key, value] of Object.entries(properties)) {
          if (value && typeof value === 'object' && 'default' in value) {
            (found[discriminator.const] ??= {})[key] = (value as { default: unknown }).default;
          }
        }
      }
    }
    for (const value of Object.values(node)) walk(value);
  };

  for (const type of ['search', 'vectorSearch'] as const) walk(getSchema(type));
  return sortDeep(found);
}

function sortDeep(table: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(
    Object.keys(table)
      .sort()
      .map((type) => [
        type,
        Object.fromEntries(Object.keys(table[type]!).sort().map((key) => [key, table[type]![key]])),
      ]),
  );
}
