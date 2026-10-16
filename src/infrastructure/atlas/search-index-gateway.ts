import type { DeployedIndex, IndexKey, LocalIndex } from '../../domain/index.ts';
import { AtlasApiError } from '../../domain/index.ts';
import type { SearchIndexGateway } from '../../application/ports.ts';
import type { AtlasClient } from './http.ts';
import { toCreateRequest, toDeployedIndex, toUpdateRequest } from './wire.ts';

/** Concrete `SearchIndexGateway` over the Atlas Admin API v2. */
export class AtlasSearchIndexGateway implements SearchIndexGateway {
  readonly cluster: string;
  readonly #client: AtlasClient;
  readonly #groupId: string;

  constructor(client: AtlasClient, groupId: string, cluster: string) {
    this.#client = client;
    this.#groupId = groupId;
    this.cluster = cluster;
  }

  async list(): Promise<DeployedIndex[]> {
    const { body } = await this.#client.get(this.#base());
    if (!Array.isArray(body)) return [];
    return body.map(toDeployedIndex).filter((index): index is DeployedIndex => index !== undefined);
  }

  async get(key: IndexKey): Promise<DeployedIndex | undefined> {
    try {
      const { body } = await this.#client.get(this.#indexPath(key));
      return body === undefined ? undefined : toDeployedIndex(body);
    } catch (error) {
      // A 404 is the honest answer to "does this index exist", not a failure.
      if (error instanceof AtlasApiError && error.httpStatus === 404) return undefined;
      throw error;
    }
  }

  async create(index: LocalIndex): Promise<{ definitionVersion: number | undefined }> {
    const { body } = await this.#client.post(this.#base(), toCreateRequest(index));
    return { definitionVersion: toDeployedIndex(body ?? null)?.definitionVersion };
  }

  async update(index: LocalIndex): Promise<{ definitionVersion: number | undefined }> {
    const { body } = await this.#client.patch(this.#indexPath(index.key), toUpdateRequest(index));
    return { definitionVersion: toDeployedIndex(body ?? null)?.definitionVersion };
  }

  async delete(key: IndexKey): Promise<void> {
    await this.#client.delete(this.#indexPath(key));
  }

  #base(): string {
    return `/api/atlas/v2/groups/${this.#groupId}/clusters/${encodeURIComponent(this.cluster)}/search/indexes`;
  }

  #indexPath(key: IndexKey): string {
    const segments = [key.database, key.collection, key.name].map(encodeURIComponent);
    return `${this.#base()}/${segments.join('/')}`;
  }
}
