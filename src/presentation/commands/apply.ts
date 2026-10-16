import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { isEmpty } from '../../domain/index.ts';
import type { ClusterPlan } from '../../domain/index.ts';
import { applyPlan, hasFailures } from '../../application/apply.ts';
import type { ApplyOptions, ApplyResult } from '../../application/apply.ts';
import { fanOut } from '../../application/fan-out.ts';
import type { ClusterOutcome } from '../../application/fan-out.ts';
import { planCluster, validateDefinitions } from '../../application/plan-cluster.ts';
import { RunStateStore } from '../../infrastructure/fs/run-state-store.ts';
import type { ResolvedCluster } from '../../infrastructure/config/load-config.ts';
import type { CommandContext } from '../context.ts';
import { EXIT } from '../exit-codes.ts';
import type { ExitCode } from '../exit-codes.ts';
import { renderApply, renderClusterTable, renderFailures, renderPlan } from '../render/human.ts';
import { applyToJson, clusterOutcomesToJson, print } from '../render/json.ts';

export interface ApplyCommandOptions extends ApplyOptions {
  /** Skip the confirmation prompt. Required in CI, where there is no tty. */
  readonly yes: boolean;
  readonly failFast: boolean;
  /** Reuse a previous run's id to resume it; a new id starts fresh. */
  readonly runId: string | undefined;
  readonly stateFile: string;
}

export interface ApplyIo {
  readonly out: (text: string) => void;
  /** Returns false to abort. Wired to a tty prompt in the CLI. */
  readonly confirm: (question: string) => Promise<boolean>;
}

/**
 * Plan everywhere, show everything, confirm once, then apply.
 *
 * The two phases are not decoration. Planning is read-only and safe to run
 * against every cluster at once, and doing it first means the confirmation
 * prompt describes the whole blast radius rather than one cluster at a time —
 * you cannot approve cluster one and then discover what cluster two was going to
 * do. It also keeps the prompt single: asking three concurrent workers to share
 * one tty produces interleaved questions and an answer applied to the wrong one.
 */
export async function runApply(
  context: CommandContext,
  options: ApplyCommandOptions,
  io: ApplyIo,
): Promise<ExitCode> {
  const local = await context.store.load();
  validateDefinitions(local, context.validator);

  const runId = options.runId ?? randomUUID();
  const stateStore = new RunStateStore(resolve(options.stateFile));
  const state = await stateStore.load(runId);
  const completed = new Set(state.completed);

  const pending = context.clusters.filter((cluster) => !completed.has(cluster.name));

  // Phase 1 — read-only.
  const planned = await fanOut(
    pending.map((cluster) => cluster.name),
    (name) => planCluster(context.gatewayFor(clusterNamed(pending, name)), local, context.validator),
    { concurrency: context.concurrency, failFast: false, completed: new Set() },
    context.reporter,
  );

  const plans = planned.outcomes.flatMap((outcome) => (outcome.status === 'ok' ? [outcome.value] : []));
  const withChanges = plans.filter((plan) => !isEmpty(plan));

  if (!context.json) {
    for (const plan of plans) io.out(renderPlan(plan));
    io.out(renderFailures(planned.outcomes));
  }

  if (withChanges.length === 0) {
    return reportNothingToDo(context, io, planned.outcomes, runId);
  }

  // Phase 2 — the part that changes production.
  if (!options.yes && !(await io.confirm(confirmationFor(withChanges)))) {
    io.out('  aborted; nothing was applied.');
    // Non-zero on purpose. An abort leaves the repo and the clusters disagreeing,
    // and a pipeline that forgot --yes must not read "did nothing" as success.
    return EXIT.CHANGES;
  }

  const applied = await fanOut(
    withChanges.map((plan) => plan.cluster),
    async (name) => {
      const plan = withChanges.find((candidate) => candidate.cluster === name)!;
      return applyPlan(
        context.gatewayFor(clusterNamed(pending, name)),
        plan,
        options,
        context.clock,
        context.reporter,
      );
    },
    { concurrency: context.concurrency, failFast: options.failFast, completed: new Set() },
    context.reporter,
    async (outcome) => {
      if (outcome.status === 'ok' && !hasFailures(outcome.value)) {
        await stateStore.record(state, outcome.cluster);
      }
    },
  );

  const results = applied.outcomes.flatMap((outcome) => (outcome.status === 'ok' ? [outcome.value] : []));

  if (context.json) {
    io.out(print({ runId, clusters: clusterOutcomesToJson(applied.outcomes, applyToJson) }));
  } else {
    for (const result of results) io.out(renderApply(result));
    io.out(renderFailures(applied.outcomes));
    if (withChanges.length > 1) io.out(renderClusterTable(applied.outcomes));
  }

  const failed =
    planned.outcomes.some((outcome) => outcome.status === 'failed') ||
    applied.outcomes.some((outcome) => outcome.status === 'failed') ||
    results.some(hasFailures);

  if (failed && !context.json) {
    io.out(`  Re-run with --run-id ${runId} to resume from the clusters that succeeded.`);
  }
  return failed ? EXIT.ERROR : EXIT.OK;
}

function reportNothingToDo(
  context: CommandContext,
  io: ApplyIo,
  outcomes: readonly ClusterOutcome<ClusterPlan>[],
  runId: string,
): ExitCode {
  if (context.json) {
    io.out(print({ runId, clusters: clusterOutcomesToJson(outcomes, () => ({ outcomes: [] })) }));
  }
  return outcomes.some((outcome) => outcome.status === 'failed') ? EXIT.ERROR : EXIT.OK;
}

function confirmationFor(plans: readonly ClusterPlan[]): string {
  const changes = plans.reduce((total, plan) => total + plan.changes.length, 0);
  const where =
    plans.length === 1 ? plans[0]!.cluster : `${plans.length} clusters (${plans.map((p) => p.cluster).join(', ')})`;
  return `Apply ${changes} change${changes === 1 ? '' : 's'} to ${where}?`;
}

/** Cluster names are unique by construction; see resolveClusters. */
function clusterNamed(clusters: readonly ResolvedCluster[], name: string): ResolvedCluster {
  const found = clusters.find((cluster) => cluster.name === name);
  if (!found) throw new Error(`internal: no configuration for cluster "${name}"`);
  return found;
}
