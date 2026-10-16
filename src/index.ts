/**
 * Library surface. The CLI is the product, but the use cases are usable on their
 * own — a deploy script that already knows its cluster list can drive them
 * directly without shelling out.
 */
export * from './domain/index.ts';
export type {
  Clock,
  DefinitionStore,
  DefinitionValidator,
  ProgressReporter,
  SearchIndexGateway,
} from './application/ports.ts';
export { silentReporter } from './application/ports.ts';
export { planCluster } from './application/plan-cluster.ts';
export { applyPlan, hasFailures } from './application/apply.ts';
export type { ApplyOptions, ApplyResult, ChangeOutcome } from './application/apply.ts';
export { pullCluster } from './application/pull.ts';
export type { PullResult } from './application/pull.ts';
export { waitForReady, waitForDeleted } from './application/wait-for-ready.ts';
export type { WaitOptions, WaitResult } from './application/wait-for-ready.ts';
export { fanOut } from './application/fan-out.ts';
export type { ClusterOutcome, FanOutOptions, FanOutResult } from './application/fan-out.ts';

export { AtlasClient, ATLAS_SEARCH_API_VERSION, DEFAULT_BASE_URL } from './infrastructure/atlas/http.ts';
export { AtlasSearchIndexGateway } from './infrastructure/atlas/search-index-gateway.ts';
export { FileDefinitionStore } from './infrastructure/fs/file-definition-store.ts';
export { SchemaValidator } from './infrastructure/validation/schema-validator.ts';
export { systemClock } from './infrastructure/clock.ts';
export { loadCredentials } from './infrastructure/config/credentials.ts';
export { EXIT } from './presentation/exit-codes.ts';
export type { ExitCode } from './presentation/exit-codes.ts';
