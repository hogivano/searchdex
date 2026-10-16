import { computePlan } from '../domain/index.ts';
import type { ClusterPlan, LocalIndex } from '../domain/index.ts';
import { DefinitionError } from '../domain/index.ts';
import type { DefinitionValidator, SearchIndexGateway } from './ports.ts';

/**
 * The read-only use case behind `diff` and `drift`, and the first half of
 * `apply`. Validation runs here too so a library caller gets it for free, but
 * the CLI calls `validateDefinitions` once up front: a bad file is a fact about
 * the repo, not about a cluster, and reporting it eighteen times under eighteen
 * cluster headings would be noise.
 */
export async function planCluster(
  gateway: SearchIndexGateway,
  local: readonly LocalIndex[],
  validator: DefinitionValidator,
): Promise<ClusterPlan> {
  validateDefinitions(local, validator);
  const deployed = await gateway.list();
  return computePlan(gateway.cluster, local, deployed);
}

/** Fail on a typo locally rather than after a round trip to Atlas. */
export function validateDefinitions(local: readonly LocalIndex[], validator: DefinitionValidator): void {
  for (const index of local) {
    const result = validator.validate(index);
    if (!result.ok) {
      throw new DefinitionError(index.source, 'does not match the Atlas Search index schema', result.errors);
    }
  }
}
