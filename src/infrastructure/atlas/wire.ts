import { INDEX_STATUSES } from '../../domain/index.ts';
import type {
  DeployedIndex,
  HostStatus,
  IndexStatus,
  IndexType,
  Json,
  JsonObject,
  LocalIndex,
} from '../../domain/index.ts';

/**
 * Translation between the Atlas wire format and the domain model.
 *
 * Kept in one file so the domain never learns the shape of `SearchIndexResponse`
 * and the wire types never leak past this boundary. Shapes below are transcribed
 * from the Atlas Admin API v2 OpenAPI spec, media type
 * `application/vnd.atlas.2024-05-30+json`.
 */

interface SearchIndexResponse {
  collectionName?: string;
  database?: string;
  name?: string;
  type?: string;
  indexID?: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: JsonObject;
  latestDefinitionVersion?: { version?: number; createdAt?: string };
  statusDetail?: SearchHostStatusDetail[];
}

interface SearchHostStatusDetail {
  hostname?: string;
  status?: string;
  queryable?: boolean;
  mainIndex?: { definitionVersion?: { version?: number }; queryable?: boolean; status?: string };
}

export function toDeployedIndex(raw: Json): DeployedIndex | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const response = raw as SearchIndexResponse;
  if (!response.database || !response.collectionName || !response.name) return undefined;

  return {
    key: {
      database: response.database,
      collection: response.collectionName,
      name: response.name,
    },
    type: toIndexType(response.type),
    definition: response.latestDefinition ?? {},
    indexID: response.indexID,
    status: toStatus(response.status),
    queryable: response.queryable === true,
    definitionVersion: response.latestDefinitionVersion?.version,
    hosts: (response.statusDetail ?? []).map(toHostStatus),
  };
}

function toHostStatus(detail: SearchHostStatusDetail): HostStatus {
  return {
    hostname: detail.hostname ?? '(unnamed host)',
    status: toStatus(detail.status),
    queryable: detail.queryable === true,
    // The version *serving* queries is the main index's, not the staged one —
    // a staged index is the build in flight, which is precisely what we wait for.
    servingVersion: detail.mainIndex?.definitionVersion?.version,
  };
}

/**
 * Unknown statuses become `UNKNOWN` rather than throwing. Atlas has changed this
 * enum before (the 2023-01-01 shape used IN_PROGRESS/STEADY), and a new value
 * should degrade the readiness signal, not break the CLI.
 */
function toStatus(value: string | undefined): IndexStatus {
  if (value === undefined) return 'UNKNOWN';
  if ((INDEX_STATUSES as readonly string[]).includes(value)) return value as IndexStatus;
  return legacyStatus(value) ?? 'UNKNOWN';
}

/** Deprecated 2023-01-01 `ClusterSearchIndex` statuses, mapped to their modern equivalents. */
function legacyStatus(value: string): IndexStatus | undefined {
  const legacy: Record<string, IndexStatus> = {
    NOT_STARTED: 'PENDING',
    IN_PROGRESS: 'BUILDING',
    STEADY: 'READY',
    MIGRATING: 'BUILDING',
    PAUSED: 'PENDING',
    STALE: 'STALE',
    FAILED: 'FAILED',
  };
  return legacy[value];
}

function toIndexType(value: string | undefined): IndexType {
  return value === 'vectorSearch' ? 'vectorSearch' : 'search';
}

/** Body for `POST .../search/indexes`. Namespace lives outside the definition. */
export function toCreateRequest(index: LocalIndex): JsonObject {
  return {
    database: index.key.database,
    collectionName: index.key.collection,
    name: index.key.name,
    type: index.type,
    definition: index.definition,
  };
}

/** Body for `PATCH .../search/indexes/{db}/{coll}/{name}`. Definition only. */
export function toUpdateRequest(index: LocalIndex): JsonObject {
  return { definition: index.definition };
}
