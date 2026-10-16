import type { ProgressReporter } from './ports.ts';

/**
 * Run one job per cluster with bounded concurrency, and remember what finished
 * so a re-run resumes instead of redoing.
 *
 * Resume is the reason this exists rather than a bare `Promise.all`: applying to
 * eighteen clusters and having the fourteenth fail should not mean re-applying
 * the first thirteen.
 */

export interface FanOutOptions {
  readonly concurrency: number;
  /** Stop scheduling new clusters after the first failure. */
  readonly failFast: boolean;
  /** Clusters already completed in a previous run, skipped here. */
  readonly completed: ReadonlySet<string>;
}

export type ClusterOutcome<T> =
  | { readonly cluster: string; readonly status: 'ok'; readonly value: T }
  | { readonly cluster: string; readonly status: 'failed'; readonly error: Error }
  | { readonly cluster: string; readonly status: 'skipped'; readonly reason: string };

export interface FanOutResult<T> {
  readonly outcomes: readonly ClusterOutcome<T>[];
}

export async function fanOut<T>(
  clusters: readonly string[],
  run: (cluster: string) => Promise<T>,
  options: FanOutOptions,
  reporter: ProgressReporter,
  onSettled?: (outcome: ClusterOutcome<T>) => Promise<void> | void,
): Promise<FanOutResult<T>> {
  const outcomes: ClusterOutcome<T>[] = [];
  const queue = [...clusters];
  let aborted = false;

  const settle = async (outcome: ClusterOutcome<T>): Promise<void> => {
    outcomes.push(outcome);
    reporter.clusterFinished(outcome.cluster, outcome.status);
    if (onSettled) await onSettled(outcome);
    if (outcome.status === 'failed' && options.failFast) aborted = true;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const cluster = queue.shift();
      if (cluster === undefined) return;
      if (aborted) {
        await settle({ cluster, status: 'skipped', reason: 'aborted after an earlier failure' });
        continue;
      }
      if (options.completed.has(cluster)) {
        await settle({ cluster, status: 'skipped', reason: 'already completed in a previous run' });
        continue;
      }
      reporter.clusterStarted(cluster);
      try {
        await settle({ cluster, status: 'ok', value: await run(cluster) });
      } catch (error) {
        await settle({
          cluster,
          status: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency, clusters.length));
  await Promise.all(Array.from({ length: workers }, worker));

  // Workers drain a shared queue, so completion order is not input order.
  // Restore it — a summary table you paste into Slack should read predictably.
  const rank = new Map(clusters.map((cluster, i) => [cluster, i]));
  return {
    outcomes: outcomes.sort((a, b) => (rank.get(a.cluster) ?? 0) - (rank.get(b.cluster) ?? 0)),
  };
}
