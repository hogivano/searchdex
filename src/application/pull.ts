import { canonicalize } from '../domain/index.ts';
import type { DeployedIndex } from '../domain/index.ts';
import type { DefinitionStore, SearchIndexGateway } from './ports.ts';

export interface PullResult {
  readonly cluster: string;
  readonly files: readonly string[];
  readonly skipped: readonly { readonly index: string; readonly reason: string }[];
}

/**
 * Write what Atlas has into the repo. The on-ramp: nobody starts with
 * definitions in git, they start with indexes somebody created in the UI.
 *
 * The written file is the *canonicalised* definition, which matters more than it
 * looks: server-owned fields and server-populated defaults are stripped, so the
 * very next `searchdex diff` reports no changes. A pull that immediately shows
 * drift is the bug that would make people uninstall the tool.
 */
export async function pullCluster(
  gateway: SearchIndexGateway,
  store: DefinitionStore,
  options: { readonly includeVectorSearch: boolean },
): Promise<PullResult> {
  const deployed = await gateway.list();
  const files: string[] = [];
  const skipped: { index: string; reason: string }[] = [];

  for (const index of deployed) {
    if (index.type === 'vectorSearch' && !options.includeVectorSearch) {
      skipped.push({ index: describe(index), reason: 'vectorSearch indexes are not managed in v0' });
      continue;
    }
    files.push(await store.write(index.key, index.type, canonicalize(index.definition)));
  }

  return { cluster: gateway.cluster, files, skipped };
}

function describe(index: DeployedIndex): string {
  return `${index.key.database}.${index.key.collection}.${index.key.name}`;
}
