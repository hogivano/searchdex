import { keyToString } from '../domain/index.ts';
import type { Change, ClusterPlan } from '../domain/index.ts';
import type { Clock, ProgressReporter, SearchIndexGateway } from './ports.ts';
import { waitForDeleted, waitForReady } from './wait-for-ready.ts';

export interface ApplyOptions {
  /** Deletes are opt-in: a missing file is far more often an incomplete repo. */
  readonly allowDelete: boolean;
  /** `false` returns as soon as Atlas accepts the change. */
  readonly wait: boolean;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export type ChangeOutcome =
  | { readonly kind: 'applied'; readonly change: Change; readonly waitedMs: number; readonly note: string | undefined }
  | { readonly kind: 'accepted'; readonly change: Change }
  | { readonly kind: 'skipped'; readonly change: Change; readonly reason: string }
  | { readonly kind: 'failed'; readonly change: Change; readonly error: Error };

export interface ApplyResult {
  readonly cluster: string;
  readonly outcomes: readonly ChangeOutcome[];
}

/**
 * Execute a plan against one cluster, one change at a time.
 *
 * Sequential on purpose: the point of the tool is to tell you when a change is
 * live, and interleaving builds turns a clear per-index timeline into a race.
 * Parallelism belongs at the cluster level (see fan-out.ts), not here.
 */
export async function applyPlan(
  gateway: SearchIndexGateway,
  plan: ClusterPlan,
  options: ApplyOptions,
  clock: Clock,
  reporter: ProgressReporter,
): Promise<ApplyResult> {
  const outcomes: ChangeOutcome[] = [];

  for (const change of plan.changes) {
    if (change.kind === 'delete' && !options.allowDelete) {
      outcomes.push({
        kind: 'skipped',
        change,
        reason: 'deleting requires --allow-delete',
      });
      continue;
    }
    try {
      outcomes.push(await applyChange(gateway, change, options, clock, reporter));
    } catch (error) {
      outcomes.push({ kind: 'failed', change, error: asError(error) });
      // Keep going: a partial apply that reports precisely what landed is more
      // useful than one that stops and leaves you guessing. The exit code and
      // the summary both reflect the failure.
    }
  }

  return { cluster: plan.cluster, outcomes };
}

async function applyChange(
  gateway: SearchIndexGateway,
  change: Change,
  options: ApplyOptions,
  clock: Clock,
  reporter: ProgressReporter,
): Promise<ChangeOutcome> {
  if (change.kind === 'delete') {
    await gateway.delete(change.key);
    if (!options.wait) return { kind: 'accepted', change };
    const startedAt = clock.now();
    await waitForDeleted(gateway, change.key, options, clock);
    return { kind: 'applied', change, waitedMs: clock.now() - startedAt, note: undefined };
  }

  const local = change.local;
  if (!local) throw new Error(`internal: ${change.kind} change for ${keyToString(change.key)} has no local definition`);

  const { definitionVersion } =
    change.kind === 'create' ? await gateway.create(local) : await gateway.update(local);

  if (!options.wait) return { kind: 'accepted', change };

  const result = await waitForReady(
    gateway,
    change.key,
    {
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      targetVersion: definitionVersion,
    },
    clock,
    reporter,
  );
  return { kind: 'applied', change, waitedMs: result.elapsedMs, note: result.note };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function hasFailures(result: ApplyResult): boolean {
  return result.outcomes.some((outcome) => outcome.kind === 'failed');
}
