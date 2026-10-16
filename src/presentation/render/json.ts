import { keyToString } from '../../domain/index.ts';
import type { ClusterPlan } from '../../domain/index.ts';
import type { ApplyResult } from '../../application/apply.ts';
import type { ClusterOutcome } from '../../application/fan-out.ts';

/**
 * `--json` for the pipeline that wants to post a diff on a pull request. Shaped
 * for a consumer, not as a dump of internal types: stable field names, no
 * undefined, and every identity rendered as the same `db.coll.name` string the
 * human output uses.
 */

export function planToJson(plan: ClusterPlan) {
  return {
    cluster: plan.cluster,
    changes: plan.changes.map((change) => ({
      kind: change.kind,
      index: keyToString(change.key),
      database: change.key.database,
      collection: change.key.collection,
      name: change.key.name,
      fields: change.fields.map((field) => ({
        path: field.path,
        deployed: field.deployed ?? null,
        local: field.local ?? null,
        certainty: field.certainty,
      })),
    })),
    unchanged: plan.unchanged.map(keyToString),
  };
}

export function applyToJson(result: ApplyResult) {
  return {
    cluster: result.cluster,
    outcomes: result.outcomes.map((outcome) => ({
      index: keyToString(outcome.change.key),
      kind: outcome.change.kind,
      result: outcome.kind,
      waitedMs: outcome.kind === 'applied' ? outcome.waitedMs : null,
      note: outcome.kind === 'applied' ? (outcome.note ?? null) : null,
      reason: outcome.kind === 'skipped' ? outcome.reason : null,
      error: outcome.kind === 'failed' ? outcome.error.message : null,
    })),
  };
}

export function clusterOutcomesToJson<T>(
  outcomes: readonly ClusterOutcome<T>[],
  valueToJson: (value: T) => unknown,
) {
  return outcomes.map((outcome) => ({
    cluster: outcome.cluster,
    status: outcome.status,
    value: outcome.status === 'ok' ? valueToJson(outcome.value) : null,
    reason: outcome.status === 'skipped' ? outcome.reason : null,
    error: outcome.status === 'failed' ? outcome.error.message : null,
  }));
}

export function print(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
