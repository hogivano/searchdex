import type { DeployedIndex, IndexKey, Json, JsonObject, LocalIndex } from './index-definition.ts';
import { keyToString } from './index-definition.ts';
import { canonicalize, deepEqual, isObject } from './normalize.ts';
import type { Change, ClusterPlan, FieldChange } from './plan.ts';

/**
 * Compare the repo against a cluster. Pure: give it two lists, get a plan.
 *
 * Comparison happens on canonicalised definitions (see normalize.ts), so key
 * order, whitespace, server-owned fields and server-populated defaults are not
 * changes. What survives that is reported field by field.
 */
export function computePlan(
  cluster: string,
  local: readonly LocalIndex[],
  deployed: readonly DeployedIndex[],
): ClusterPlan {
  const localByKey = new Map(local.map((index) => [keyToString(index.key), index]));
  const deployedByKey = new Map(deployed.map((index) => [keyToString(index.key), index]));

  const changes: Change[] = [];
  const unchanged: IndexKey[] = [];

  for (const [id, localIndex] of localByKey) {
    const deployedIndex = deployedByKey.get(id);
    if (!deployedIndex) {
      changes.push({ kind: 'create', key: localIndex.key, local: localIndex, deployed: undefined, fields: [] });
      continue;
    }
    const fields = diffDefinitions(deployedIndex.definition, localIndex.definition);
    if (fields.length === 0 && deployedIndex.type === localIndex.type) {
      unchanged.push(localIndex.key);
      continue;
    }
    changes.push({
      kind: 'update',
      key: localIndex.key,
      local: localIndex,
      deployed: deployedIndex,
      fields: typeChange(deployedIndex, localIndex, fields),
    });
  }

  for (const [id, deployedIndex] of deployedByKey) {
    if (localByKey.has(id)) continue;
    changes.push({ kind: 'delete', key: deployedIndex.key, local: undefined, deployed: deployedIndex, fields: [] });
  }

  return { cluster, changes: changes.sort(byKey), unchanged };
}

/** Index type is part of the definition for diff purposes, but lives outside it on the wire. */
function typeChange(
  deployed: DeployedIndex,
  local: LocalIndex,
  fields: readonly FieldChange[],
): FieldChange[] {
  if (deployed.type === local.type) return [...fields];
  return [
    { path: 'type', deployed: deployed.type, local: local.type, certainty: 'certain' },
    ...fields,
  ];
}

function byKey(a: Change, b: Change): number {
  return keyToString(a.key).localeCompare(keyToString(b.key));
}

/**
 * Field-level differences between two definitions, after canonicalisation.
 *
 * A field on one side only is reported as `unexplained` rather than as a
 * confident change: we cannot tell a genuine addition from a server default we
 * have not catalogued, and claiming certainty we do not have is how a drift
 * checker loses its audience.
 */
export function diffDefinitions(deployed: JsonObject, local: JsonObject): FieldChange[] {
  const changes: FieldChange[] = [];
  walk(canonicalize(deployed), canonicalize(local), '', changes);
  return changes;
}

function walk(deployed: Json | undefined, local: Json | undefined, path: string, out: FieldChange[]): void {
  if (deepEqualOrBothMissing(deployed, local)) return;

  // Only recurse where both sides are plain objects; anywhere else the whole
  // value is the unit of change, which is what a reader wants to see.
  if (isObject(deployed) && isObject(local)) {
    for (const key of unionKeys(deployed, local)) {
      walk(deployed[key], local[key], path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }

  out.push({
    path: path === '' ? '(whole definition)' : path,
    deployed,
    local,
    certainty: deployed === undefined || local === undefined ? 'unexplained' : 'certain',
  });
}

function deepEqualOrBothMissing(a: Json | undefined, b: Json | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return deepEqual(a, b);
}

function unionKeys(a: JsonObject, b: JsonObject): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}
