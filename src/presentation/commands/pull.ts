import { pullCluster } from '../../application/pull.ts';
import { SearchdexError } from '../../domain/index.ts';
import type { CommandContext } from '../context.ts';
import { EXIT } from '../exit-codes.ts';
import type { ExitCode } from '../exit-codes.ts';
import { print } from '../render/json.ts';

/**
 * Pull is single-cluster on purpose. Writing definitions from several clusters
 * into one directory would silently pick a winner per index, and "which cluster
 * is my repo describing?" is not a question a tool should answer by coin flip.
 */
export async function runPull(
  context: CommandContext,
  options: { readonly includeVectorSearch: boolean },
  out: (text: string) => void,
): Promise<ExitCode> {
  if (context.clusters.length !== 1) {
    throw new SearchdexError('pull works on one cluster at a time', [
      `Configured clusters: ${context.clusters.map((cluster) => cluster.name).join(', ')}.`,
      'Pass --cluster <name> to choose which one the repo should describe.',
    ]);
  }

  const cluster = context.clusters[0]!;
  const result = await pullCluster(context.gatewayFor(cluster), context.store, options);

  if (context.json) {
    out(print(result));
    return EXIT.OK;
  }

  out('');
  out(`  cluster: ${result.cluster}`);
  for (const file of result.files) out(`    wrote ${file}`);
  for (const skip of result.skipped) out(`    skipped ${skip.index}: ${skip.reason}`);
  out('');
  out(`  ${result.files.length} definition${result.files.length === 1 ? '' : 's'} written.`);
  out('  Run `searchdex diff` — it should report no changes.');
  out('');
  return EXIT.OK;
}
