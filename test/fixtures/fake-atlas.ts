import type {
  DeployedIndex,
  IndexKey,
  IndexStatus,
  JsonObject,
  LocalIndex,
} from '../../src/domain/index.ts';
import { keyToString } from '../../src/domain/index.ts';
import type { Clock, SearchIndexGateway } from '../../src/application/ports.ts';

/**
 * An in-memory Atlas that behaves like the real one in the ways that matter:
 * it fills in server defaults, attaches server-owned fields, takes a
 * configurable number of polls to finish a build, and — critically — keeps
 * serving the previous definition version while a new one builds.
 *
 * That last behaviour is what makes a status-only readiness check wrong, so a
 * fake without it would let the bug this tool exists to prevent pass the tests.
 */

export interface FakeIndexOptions {
  /** Polls before the build completes. 0 means instantly ready. */
  readonly buildPolls?: number;
  readonly failBuild?: boolean;
  readonly hosts?: readonly string[];
}

interface StoredIndex {
  key: IndexKey;
  type: 'search' | 'vectorSearch';
  definition: JsonObject;
  indexID: string;
  /** Version currently answering queries. */
  servingVersion: number;
  /** Version most recently accepted. Equals servingVersion once built. */
  latestVersion: number;
  pollsRemaining: number;
  failed: boolean;
  hosts: readonly string[];
}

/**
 * Fill in defaults the way Atlas does, including the per-field ones.
 *
 * The string-field row is not decoration: real mongot returns `indexOptions`,
 * `store` and `norms` on every string field, and an earlier version of this fake
 * did not — which let a normalisation bug pass every unit test and only surface
 * against a live container. The fake now lies less.
 */
function applyServerDefaults(definition: JsonObject): JsonObject {
  const withDefaults: JsonObject = {
    analyzer: 'lucene.standard',
    searchAnalyzer: 'lucene.standard',
    numPartitions: 1,
    storedSource: false,
    ...definition,
  };
  const mappings = withDefaults['mappings'];
  if (isObject(mappings)) {
    withDefaults['mappings'] = { dynamic: false, ...mappings, ...withFieldDefaults(mappings) };
  }
  return withDefaults;
}

function withFieldDefaults(mappings: JsonObject): JsonObject {
  const fields = mappings['fields'];
  if (!isObject(fields)) return {};
  return {
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        isObject(field) && field['type'] === 'string'
          ? { indexOptions: 'offsets', store: true, norms: 'include', ...field }
          : field,
      ]),
    ),
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class FakeAtlas implements SearchIndexGateway {
  readonly #indexes = new Map<string, StoredIndex>();
  #nextId = 1;
  readonly calls: string[] = [];

  readonly cluster: string;
  readonly #options: FakeIndexOptions;

  constructor(cluster: string, options: FakeIndexOptions = {}) {
    this.cluster = cluster;
    this.#options = options;
  }

  /** Seed an index as if somebody had created it in the Atlas UI. */
  seed(key: IndexKey, definition: JsonObject, type: 'search' | 'vectorSearch' = 'search'): void {
    this.#indexes.set(keyToString(key), {
      key,
      type,
      definition: applyServerDefaults(definition),
      indexID: `${this.#nextId++}`.padStart(24, '0'),
      servingVersion: 1,
      latestVersion: 1,
      pollsRemaining: 0,
      failed: false,
      hosts: this.#options.hosts ?? ['host-0', 'host-1'],
    });
  }

  async list(): Promise<DeployedIndex[]> {
    this.calls.push('list');
    return [...this.#indexes.values()].map((stored) => this.#toDeployed(stored));
  }

  async get(key: IndexKey): Promise<DeployedIndex | undefined> {
    this.calls.push(`get ${keyToString(key)}`);
    const stored = this.#indexes.get(keyToString(key));
    if (!stored) return undefined;
    // Every read advances the build, which is what makes the poll loop terminate.
    if (stored.pollsRemaining > 0) {
      stored.pollsRemaining -= 1;
      if (stored.pollsRemaining === 0 && !stored.failed) stored.servingVersion = stored.latestVersion;
    }
    return this.#toDeployed(stored);
  }

  async create(index: LocalIndex): Promise<{ definitionVersion: number | undefined }> {
    this.calls.push(`create ${keyToString(index.key)}`);
    const buildPolls = this.#options.buildPolls ?? 0;
    this.#indexes.set(keyToString(index.key), {
      key: index.key,
      type: index.type,
      definition: applyServerDefaults(index.definition),
      indexID: `${this.#nextId++}`.padStart(24, '0'),
      servingVersion: buildPolls === 0 ? 1 : 0,
      latestVersion: 1,
      pollsRemaining: buildPolls,
      failed: this.#options.failBuild === true,
      hosts: this.#options.hosts ?? ['host-0', 'host-1'],
    });
    return { definitionVersion: 1 };
  }

  async update(index: LocalIndex): Promise<{ definitionVersion: number | undefined }> {
    this.calls.push(`update ${keyToString(index.key)}`);
    const stored = this.#indexes.get(keyToString(index.key));
    if (!stored) throw new Error(`no such index: ${keyToString(index.key)}`);
    stored.definition = applyServerDefaults(index.definition);
    stored.latestVersion += 1;
    stored.pollsRemaining = this.#options.buildPolls ?? 0;
    stored.failed = this.#options.failBuild === true;
    // servingVersion deliberately unchanged: Atlas keeps answering queries from
    // the old definition until the new one finishes building.
    if (stored.pollsRemaining === 0 && !stored.failed) stored.servingVersion = stored.latestVersion;
    return { definitionVersion: stored.latestVersion };
  }

  async delete(key: IndexKey): Promise<void> {
    this.calls.push(`delete ${keyToString(key)}`);
    this.#indexes.delete(keyToString(key));
  }

  #toDeployed(stored: StoredIndex): DeployedIndex {
    const building = stored.pollsRemaining > 0;
    const status: IndexStatus = stored.failed && !building ? 'FAILED' : building && stored.servingVersion === 0 ? 'BUILDING' : 'READY';
    const queryable = stored.servingVersion > 0 && !stored.failed;
    return {
      key: stored.key,
      type: stored.type,
      definition: stored.definition,
      indexID: stored.indexID,
      status,
      queryable,
      definitionVersion: stored.latestVersion,
      hosts: stored.hosts.map((hostname) => ({
        hostname,
        status,
        queryable,
        servingVersion: stored.servingVersion,
      })),
    };
  }
}

/** A clock that never actually waits, so readiness tests run in milliseconds. */
export function fakeClock(stepMs = 1000): Clock & { elapsed: number } {
  const clock = {
    elapsed: 0,
    now: () => clock.elapsed,
    sleep: async (ms: number) => {
      clock.elapsed += ms === 0 ? stepMs : ms;
    },
  };
  return clock;
}
