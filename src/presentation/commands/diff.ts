import { hasUnexplained, isEmpty } from '../../domain/index.ts';
import type { ClusterPlan } from '../../domain/index.ts';
import { planCluster, validateDefinitions } from '../../application/plan-cluster.ts';
import { fanOut } from '../../application/fan-out.ts';
import type { CommandContext } from '../context.ts';
import { EXIT } from '../exit-codes.ts';
import type { ExitCode } from '../exit-codes.ts';
import { renderClusterTable, renderFailures, renderPlan, renderUnexplainedNote } from '../render/human.ts';
import { clusterOutcomesToJson, planToJson, print } from '../render/json.ts';

/**
 * `diff` and `drift` are the same computation; they differ only in what the exit
 * code means. Sharing the implementation is what guarantees CI is gating on
 * exactly what a developer saw locally.
 */
export interface DiffOptions {
  /** `drift` exits 1 when the repo and the cluster disagree; `diff` exits 0. */
  readonly failOnChanges: boolean;
}

export async function runDiff(
  context: CommandContext,
  options: DiffOptions,
  out: (text: string) => void,
): Promise<ExitCode> {
  const local = await context.store.load();
  // A malformed definition is a fact about the repo, so it is caught here and
  // raised as one error — not once per cluster, inside the fan-out.
  validateDefinitions(local, context.validator);

  const { outcomes } = await fanOut(
    context.clusters.map((cluster) => cluster.name),
    async (name) => {
      const cluster = context.clusters.find((candidate) => candidate.name === name)!;
      return planCluster(context.gatewayFor(cluster), local, context.validator);
    },
    { concurrency: context.concurrency, failFast: false, completed: new Set() },
    context.reporter,
  );

  const plans = outcomes.flatMap((outcome) => (outcome.status === 'ok' ? [outcome.value] : []));
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');

  if (context.json) {
    out(print({ clusters: clusterOutcomesToJson(outcomes, planToJson) }));
  } else {
    for (const plan of plans) out(renderPlan(plan));
    if (plans.some(hasUnexplained)) out(renderUnexplainedNote());
    if (failed.length > 0) out(renderFailures(outcomes));
    if (context.clusters.length > 1) out(renderClusterTable(outcomes));
  }

  if (failed.length > 0) return EXIT.ERROR;
  const changed = plans.some((plan: ClusterPlan) => !isEmpty(plan));
  return changed && options.failOnChanges ? EXIT.CHANGES : EXIT.OK;
}
