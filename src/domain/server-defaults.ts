import type { Json } from './index-definition.ts';

/**
 * What Atlas fills in when you leave a field out.
 *
 * This table is the single most load-bearing piece of data in the tool. Get it
 * wrong in one direction and `diff` reports drift on a file nobody touched; get
 * it wrong in the other and it hides a change that is really there.
 *
 * Every value is transcribed from MongoDB's own published schemas
 * (`@mongodb-js/search-index-schema`) rather than from observation or memory.
 * `test/unit/server-defaults.test.ts` regenerates the table from that package
 * and fails if the two disagree, so a schema release cannot quietly invalidate
 * it — the table is checked in for auditability, not because it is hand-written.
 */

/** Defaults at a fixed path in the definition. */
export const PATH_DEFAULTS: Readonly<Record<string, Json>> = {
  analyzer: 'lucene.standard',
  searchAnalyzer: 'lucene.standard',
  numPartitions: 1,
  storedSource: false,
  'mappings.dynamic': false,
};

/**
 * Defaults that depend on a `type` discriminator rather than on a path.
 *
 * Field mappings, analyzers, tokenizers and token filters all identify
 * themselves with `type`, so one lookup covers `mappings.fields.title` (a
 * `string`) and `analyzers[0].tokenizer` (a `standard`) alike — which matters
 * because field names are arbitrary and nesting is unbounded.
 *
 * The `string` row is why this exists: mongot returns `indexOptions`, `norms`
 * and `store` on every string field, and a hand-written definition never has
 * them. Without this row, every string field in a repo shows three spurious
 * differences.
 */
export const TYPE_DEFAULTS: Readonly<Record<string, Readonly<Record<string, Json>>>> = {
  asciiFolding: { originalTokens: 'omit' },
  autocomplete: {
    analyzer: 'lucene.standard',
    foldDiacritics: true,
    maxGrams: 15,
    minGrams: 2,
    tokenization: 'edgeGram',
  },
  daitchMokotoffSoundex: { originalTokens: 'include' },
  document: { dynamic: false },
  doubleMetaphone: { maxCodeLength: 4, originalTokens: 'include' },
  edgeGram: { termNotInBounds: 'omit' },
  embeddedDocuments: { dynamic: false },
  geo: { indexShapes: false },
  icuNormalizer: { normalizationForm: 'nfc' },
  length: { max: 255, min: 0 },
  nGram: { termNotInBounds: 'omit' },
  number: { indexDoubles: true, indexIntegers: true, representation: 'double' },
  numberFacet: { indexDoubles: true, indexIntegers: true },
  standard: { maxTokenLength: 255 },
  stopword: { ignoreCase: true },
  string: { indexOptions: 'offsets', norms: 'include', store: true },
  token: { normalizer: 'none' },
  uaxUrlEmail: { maxTokenLength: 255 },
  vector: { indexingMethod: 'hnsw', quantization: 'none' },
  whitespace: { maxTokenLength: 255 },
};

/**
 * Fields Atlas owns. They appear only in responses, never in a definition you
 * author, so they are dropped from both sides before comparing.
 *
 * Source: Atlas Admin API v2 `SearchIndexResponse` (2024-05-30).
 */
export const SERVER_OWNED_FIELDS: readonly string[] = [
  'indexID',
  'status',
  'statusDetail',
  'queryable',
  'latestDefinition',
  'latestDefinitionVersion',
  'latestVersion',
  'synonymMappingStatus',
  'synonymMappingStatusDetail',
];
