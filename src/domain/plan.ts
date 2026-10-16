import type { DeployedIndex, IndexKey, Json, LocalIndex } from './index-definition.ts';

/**
 * A plan is the whole answer to "what would apply do?" — computed once, then
 * rendered, confirmed, and executed. Nothing downstream re-derives it, so what
 * you confirm is exactly what runs.
 */

export type ChangeKind = 'create' | 'update' | 'delete';

/**
 * How sure we are that a field-level difference is real.
 *
 * `certain` — both sides carry the field and the values differ.
 * `unexplained` — the field is present on one side only and we have no
 *   documented server default for it. It may be drift, or it may be a default we
 *   have not catalogued. We say which, rather than guessing.
 */
export type Certainty = 'certain' | 'unexplained';

export interface FieldChange {
  /** Dotted path into the definition, e.g. `mappings.fields.title.analyzer`. */
  readonly path: string;
  readonly deployed: Json | undefined;
  readonly local: Json | undefined;
  readonly certainty: Certainty;
}

export interface Change {
  readonly kind: ChangeKind;
  readonly key: IndexKey;
  readonly local: LocalIndex | undefined;
  readonly deployed: DeployedIndex | undefined;
  /** Populated for `update` only; empty for create and delete. */
  readonly fields: readonly FieldChange[];
}

export interface ClusterPlan {
  readonly cluster: string;
  readonly changes: readonly Change[];
  /**
   * Indexes present in both and equal after normalisation. Not printed by
   * default, but `--json` consumers want the full picture.
   */
  readonly unchanged: readonly IndexKey[];
}

export function isEmpty(plan: ClusterPlan): boolean {
  return plan.changes.length === 0;
}

export function countByKind(plan: ClusterPlan): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = { create: 0, update: 0, delete: 0 };
  for (const change of plan.changes) counts[change.kind] += 1;
  return counts;
}

/** True if any reported difference is one we could not fully explain. */
export function hasUnexplained(plan: ClusterPlan): boolean {
  return plan.changes.some((change) =>
    change.fields.some((field) => field.certainty === 'unexplained'),
  );
}
