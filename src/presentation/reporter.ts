import type { ProgressReporter } from '../application/ports.ts';

/**
 * Live progress on stderr, so `searchdex apply --json | jq` still works while a
 * human watches the build. Quiet mode drops it entirely for CI logs that only
 * want the final answer.
 */
export function createReporter(options: {
  readonly quiet: boolean;
  readonly write: (line: string) => void;
}): ProgressReporter {
  if (options.quiet) {
    return { indexStateChanged: () => {}, clusterStarted: () => {}, clusterFinished: () => {} };
  }
  return {
    indexStateChanged: ({ index, state, detail, elapsedMs }) => {
      const suffix = detail ? ` — ${detail}` : '';
      options.write(`    ${index}  ${state} (${(elapsedMs / 1000).toFixed(0)}s)${suffix}`);
    },
    clusterStarted: (cluster) => options.write(`  ${cluster}: starting`),
    clusterFinished: (cluster, outcome) => options.write(`  ${cluster}: ${outcome}`),
  };
}
