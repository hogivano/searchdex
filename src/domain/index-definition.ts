/**
 * The domain vocabulary: what a search index is, independent of how Atlas
 * happens to represent it on the wire or how we happen to store it on disk.
 */

/** Any value that survives a JSON round-trip. Index definitions are exactly this. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

/** v0 manages `search`. `vectorSearch` is modelled but not yet applied — see README. */
export type IndexType = 'search' | 'vectorSearch';

/**
 * What makes two indexes "the same index". Atlas identifies an index by its
 * indexID, but that is server-owned and absent from a fresh repo, so identity
 * here is the namespace plus the name — the tuple a human actually reasons about.
 */
export interface IndexKey {
  readonly database: string;
  readonly collection: string;
  readonly name: string;
}

/** An index definition as it lives in the repo. */
export interface LocalIndex {
  readonly key: IndexKey;
  readonly type: IndexType;
  /** The `definition` payload only — never the namespace or server fields. */
  readonly definition: JsonObject;
  /** Where it came from, so errors can point at a file. */
  readonly source: string;
}

/** An index definition as Atlas currently reports it. */
export interface DeployedIndex {
  readonly key: IndexKey;
  readonly type: IndexType;
  readonly definition: JsonObject;
  readonly indexID: string | undefined;
  readonly status: IndexStatus;
  /** Atlas' own answer to "can queries use this index on every host?" */
  readonly queryable: boolean;
  /** Version counter Atlas assigns each accepted definition. Drives readiness. */
  readonly definitionVersion: number | undefined;
  readonly hosts: readonly HostStatus[];
}

/**
 * Per-host build state. Atlas keeps serving the previous definition while a new
 * one builds, so this is the only place that tells you whether the definition
 * you just pushed is the one answering queries.
 */
export interface HostStatus {
  readonly hostname: string;
  readonly status: IndexStatus;
  readonly queryable: boolean;
  /** Version of the definition currently *serving* queries on this host. */
  readonly servingVersion: number | undefined;
}

/**
 * Verified against the Atlas Admin API v2 OpenAPI spec (`SearchIndexResponse`,
 * media type `application/vnd.atlas.2024-05-30+json`) on 2026-09-09.
 *
 * The older `ClusterSearchIndex` shape used IN_PROGRESS/STEADY/MIGRATING/PAUSED;
 * those belong to the deprecated 2023-01-01 resource and are accepted on read so
 * a cluster still answering with them does not crash the tool.
 */
export const INDEX_STATUSES = [
  'PENDING',
  'BUILDING',
  'READY',
  'STALE',
  'FAILED',
  'DELETING',
  'DOES_NOT_EXIST',
] as const;

export type IndexStatus = (typeof INDEX_STATUSES)[number] | 'UNKNOWN';

/** Stable string form of an index identity. Used as a map key and in output. */
export function keyToString(key: IndexKey): string {
  return `${key.database}.${key.collection}.${key.name}`;
}

