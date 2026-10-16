import type { Collection, Db, MongoClient } from 'mongodb';
import type { DeployedIndex, IndexKey, IndexStatus, JsonObject, LocalIndex } from '../../src/domain/index.ts';
import type { SearchIndexGateway } from '../../src/application/ports.ts';

/**
 * A `SearchIndexGateway` backed by the MongoDB driver instead of the Atlas
 * Admin API, so the use cases can be exercised against a real `mongot` in
 * `@mongodb-js/atlas-local`.
 *
 * This exists only in the test tree, and on purpose. Local Atlas runs mongod and
 * mongot but serves no Admin API, so there is no HTTP endpoint to point the
 * production gateway at. Because the gateway is a port,
 * a second adapter costs forty lines and buys an acceptance test that runs a
 * real `$search` query against a real index build.
 *
 * It must never move into `src/`: shipping a driver-backed path would drag the
 * whole driver/ODM version matrix into a tool that is currently ODM-agnostic by
 * construction — exactly what the design says to resist.
 */

/** Shape returned by `$listSearchIndexes`. Mirrors SearchIndexResponse closely. */
interface ListSearchIndexesResult {
  id?: string;
  name: string;
  type?: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: JsonObject;
  latestDefinitionVersion?: { version?: number };
  statusDetail?: {
    hostname?: string;
    status?: string;
    queryable?: boolean;
    mainIndex?: { definitionVersion?: { version?: number } };
  }[];
}

export class DriverSearchIndexGateway implements SearchIndexGateway {
  readonly cluster: string;
  readonly #db: Db;

  constructor(client: MongoClient, databaseName: string, cluster = 'atlas-local') {
    this.#db = client.db(databaseName);
    this.cluster = cluster;
  }

  async list(): Promise<DeployedIndex[]> {
    const collections = await this.#db.listCollections({}, { nameOnly: true }).toArray();
    const indexes: DeployedIndex[] = [];
    for (const { name } of collections) {
      for (const raw of await this.#listOn(this.#db.collection(name))) {
        indexes.push(this.#toDeployed(name, raw));
      }
    }
    return indexes;
  }

  async get(key: IndexKey): Promise<DeployedIndex | undefined> {
    const raw = (await this.#listOn(this.#db.collection(key.collection))).find(
      (index) => index.name === key.name,
    );
    return raw === undefined ? undefined : this.#toDeployed(key.collection, raw);
  }

  async create(index: LocalIndex): Promise<{ definitionVersion: number | undefined }> {
    await this.#db.collection(index.key.collection).createSearchIndex({
      name: index.key.name,
      type: index.type,
      definition: index.definition,
    });
    return { definitionVersion: (await this.get(index.key))?.definitionVersion };
  }

  async update(index: LocalIndex): Promise<{ definitionVersion: number | undefined }> {
    const before = (await this.get(index.key))?.definitionVersion ?? 0;
    await this.#db
      .collection(index.key.collection)
      .updateSearchIndex(index.key.name, index.definition);
    // mongot bumps the version asynchronously; the target is simply "newer than
    // what was serving before the update".
    return { definitionVersion: before + 1 };
  }

  async delete(key: IndexKey): Promise<void> {
    await this.#db.collection(key.collection).dropSearchIndex(key.name);
  }

  async #listOn(collection: Collection): Promise<ListSearchIndexesResult[]> {
    return (await collection.listSearchIndexes().toArray()) as unknown as ListSearchIndexesResult[];
  }

  #toDeployed(collectionName: string, raw: ListSearchIndexesResult): DeployedIndex {
    const status = (raw.status ?? 'UNKNOWN') as IndexStatus;
    return {
      key: { database: this.#db.databaseName, collection: collectionName, name: raw.name },
      type: raw.type === 'vectorSearch' ? 'vectorSearch' : 'search',
      definition: raw.latestDefinition ?? {},
      indexID: raw.id,
      status,
      queryable: raw.queryable === true,
      definitionVersion: raw.latestDefinitionVersion?.version,
      hosts: (raw.statusDetail ?? []).map((detail) => ({
        hostname: detail.hostname ?? 'local',
        status: (detail.status ?? status) as IndexStatus,
        queryable: detail.queryable === true,
        servingVersion: detail.mainIndex?.definitionVersion?.version,
      })),
    };
  }
}
