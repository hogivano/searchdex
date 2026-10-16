import { getSchema } from '@mongodb-js/search-index-schema';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { LocalIndex } from '../../domain/index.ts';
import type { DefinitionValidator } from '../../application/ports.ts';

/**
 * Validate against MongoDB's own published schemas rather than a hand-rolled
 * copy — they ship `@mongodb-js/search-index-schema` for exactly this, and a
 * second implementation of the rules would drift from theirs within a release.
 *
 * The point is failing on a typo locally instead of after a round trip to Atlas.
 */
export class SchemaValidator implements DefinitionValidator {
  readonly #ajv: Ajv;
  readonly #compiled = new Map<string, ValidateFunction>();

  constructor() {
    // allErrors: the whole list of problems in one pass beats fixing them one
    // round trip at a time. strict: false because MongoDB's schemas carry editor
    // annotations (markdownDescription, suggestSortText) that ajv rejects in
    // strict mode but that are harmless to validation.
    this.#ajv = new Ajv({ allErrors: true, strict: false });
  }

  validate(index: LocalIndex): { ok: true } | { ok: false; errors: string[] } {
    const validate = this.#validatorFor(index.type);
    if (validate(index.definition)) return { ok: true };
    return { ok: false, errors: (validate.errors ?? []).map(format) };
  }

  #validatorFor(type: 'search' | 'vectorSearch'): ValidateFunction {
    const cached = this.#compiled.get(type);
    if (cached) return cached;
    const compiled = this.#ajv.compile(flattenBundle(getSchema(type)));
    this.#compiled.set(type, compiled);
    return compiled;
  }
}

/**
 * Make the published bundle compilable.
 *
 * `getSchema()` returns a bundle whose external `$ref`s are already inlined, but
 * the inlined subschemas kept their original `$id`s. That shifts ajv's base URI
 * at every nesting level, so an internal `$ref` written as
 * `search/index.json#/allOf/0/...` resolves against the wrong document and
 * compilation fails outright.
 *
 * Dropping nested identifiers and pointing every `$ref` at the current document
 * leaves the constraints untouched — the pointers already address this bundle,
 * they just say so by name instead of with `#`.
 */
function flattenBundle(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown, isRoot: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, false));
    if (typeof node !== 'object' || node === null) return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!isRoot && (key === '$id' || key === '$schema')) continue;
      if (key === '$ref' && typeof value === 'string') {
        out[key] = `#${value.slice(value.indexOf('#') + 1)}`;
        continue;
      }
      out[key] = walk(value, false);
    }
    return out;
  };

  return walk(schema, true) as Record<string, unknown>;
}

function format(error: { instancePath?: string; message?: string }): string {
  const path = error.instancePath ? error.instancePath.replace(/^\//, '').replaceAll('/', '.') : '(root)';
  return `${path}: ${error.message ?? 'is invalid'}`;
}

/** For `--no-validate`, and for tests that deliberately feed odd definitions. */
export const permissiveValidator: DefinitionValidator = {
  validate: () => ({ ok: true }),
};
