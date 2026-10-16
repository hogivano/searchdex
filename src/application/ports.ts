import type { DeployedIndex, IndexKey, JsonObject, LocalIndex } from '../domain/index.ts';

/**
 * The seams. Use cases below depend on these interfaces and nothing else, which
 * is what lets the whole tool be tested against an in-memory Atlas rather than a
 * live cluster.
 */

/** Read and write search indexes on one Atlas cluster. */
export interface SearchIndexGateway {
  readonly cluster: string;
  /** Every search index on the cluster, in one call where the API allows it. */
  list(): Promise<DeployedIndex[]>;
  get(key: IndexKey): Promise<DeployedIndex | undefined>;
  /** Returns the definition version Atlas assigned, when it reports one. */
  create(index: LocalIndex): Promise<{ definitionVersion: number | undefined }>;
  update(index: LocalIndex): Promise<{ definitionVersion: number | undefined }>;
  delete(key: IndexKey): Promise<void>;
}

/** Read and write the `search-indexes/` directory. */
export interface DefinitionStore {
  load(): Promise<LocalIndex[]>;
  write(key: IndexKey, type: 'search' | 'vectorSearch', definition: JsonObject): Promise<string>;
}

/** Validate a definition before it costs a round trip. */
export interface DefinitionValidator {
  validate(index: LocalIndex): { ok: true } | { ok: false; errors: string[] };
}

/** Injected so tests can run the readiness loop without real time passing. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Progress out of the use cases. Deliberately not a logger: these are domain
 * events, and the presentation layer decides whether they become a spinner, a
 * line of text, or a JSON record.
 */
export interface ProgressReporter {
  indexStateChanged(event: {
    cluster: string;
    index: string;
    state: string;
    detail: string | undefined;
    elapsedMs: number;
  }): void;
  clusterStarted(cluster: string): void;
  clusterFinished(cluster: string, outcome: 'ok' | 'failed' | 'skipped'): void;
}

export const silentReporter: ProgressReporter = {
  indexStateChanged: () => {},
  clusterStarted: () => {},
  clusterFinished: () => {},
};
