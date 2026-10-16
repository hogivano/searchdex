import type { Json, JsonObject } from './index-definition.ts';
import { PATH_DEFAULTS, SERVER_OWNED_FIELDS, TYPE_DEFAULTS } from './server-defaults.ts';

/**
 * Normalisation: the difference between a drift checker people trust and one
 * they mute in week two.
 *
 * Atlas never hands back the definition you sent. It adds the fields it owns and
 * fills in every default you omitted — a `{"type": "string"}` field comes back
 * carrying `indexOptions`, `store` and `norms`. Comparing raw JSON therefore
 * reports drift on a file nobody touched.
 *
 * Three rules produce a canonical form, and a fourth rule lives in diff.ts:
 * anything these cannot explain is reported as *unexplained* rather than
 * silently dropped. Hiding a real change is the worse failure of the two.
 */

const SERVER_OWNED = new Set(SERVER_OWNED_FIELDS);

/**
 * Canonical form: server-owned fields removed, default-valued fields removed,
 * object keys sorted. Array order is preserved — element order in `analyzers`
 * and in a token-filter chain is meaningful to Lucene, so reordering is real
 * drift, not formatting.
 */
export function canonicalize(definition: JsonObject): JsonObject {
  return normalize(definition, '') as JsonObject;
}

/** Stable text form. Two definitions are equal iff these strings are equal. */
export function canonicalString(definition: JsonObject): string {
  return JSON.stringify(canonicalize(definition));
}

export function definitionsEqual(a: JsonObject, b: JsonObject): boolean {
  return canonicalString(a) === canonicalString(b);
}

function normalize(value: Json, path: string): Json {
  if (Array.isArray(value)) return value.map((item, i) => normalize(item, `${path}.${i}`));
  if (!isObject(value)) return value;

  // `type` selects which defaults apply to this object's own properties, so it
  // has to be read before deciding what to drop from it.
  const typeDefaults = defaultsForType(value['type']);

  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    if (SERVER_OWNED.has(key)) continue;

    const child = value[key] as Json;
    const childPath = path === '' ? key : `${path}.${key}`;

    if (isDefault(PATH_DEFAULTS[childPath], child)) continue;
    if (isDefault(typeDefaults[key], child)) continue;

    out[key] = normalize(child, childPath);
  }
  return out;
}

function defaultsForType(type: Json | undefined): Readonly<Record<string, Json>> {
  if (typeof type !== 'string') return {};
  return TYPE_DEFAULTS[type] ?? {};
}

function isDefault(expected: Json | undefined, actual: Json): boolean {
  return expected !== undefined && deepEqual(expected, actual);
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: Json, b: Json): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key] as Json);
  return out;
}

