import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { SearchdexError } from '../../domain/index.ts';

/**
 * Config is optional. One cluster, one project, definitions in
 * `./search-indexes/` needs no file at all — the flags cover it. A config file
 * exists for the case flags cannot express: several clusters under one command.
 */

export interface ClusterConfig {
  readonly name: string;
  /** Falls back to the top-level projectId when a cluster does not set one. */
  readonly projectId?: string;
}

export interface SearchdexConfig {
  readonly projectId?: string;
  readonly clusters: readonly (string | ClusterConfig)[];
  readonly directory?: string;
  readonly baseUrl?: string;
  readonly concurrency?: number;
}

export interface ResolvedCluster {
  readonly name: string;
  readonly projectId: string;
}

const CONFIG_FILENAMES = [
  'searchdex.config.ts',
  'searchdex.config.js',
  'searchdex.config.mjs',
  'searchdex.config.json',
];

export async function findConfigFile(cwd: string): Promise<string | undefined> {
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(cwd, name);
    if (await exists(path)) return path;
  }
  return undefined;
}

/**
 * `.json` is read directly; `.ts`/`.js`/`.mjs` are imported, so a config can
 * compute its cluster list (from an environment, a registry, a JSON file) rather
 * than hard-coding eighteen names. `.ts` relies on Node's own type stripping —
 * available from Node 22.6 behind a flag and unflagged from 23.6.
 */
export async function loadConfigFile(path: string): Promise<SearchdexConfig> {
  if (path.endsWith('.json')) {
    return parseConfig(JSON.parse(await readFile(path, 'utf8')), path);
  }
  const specifier = isAbsolute(path) ? pathToFileURL(path).href : path;
  const module = (await import(specifier).catch((error: unknown) => {
    throw new SearchdexError(`could not load ${path}`, [(error as Error).message]);
  })) as { default?: unknown };
  return parseConfig(module.default, path);
}

function parseConfig(value: unknown, path: string): SearchdexConfig {
  if (typeof value !== 'object' || value === null) {
    throw new SearchdexError(`${path} must export a config object`);
  }
  const config = value as SearchdexConfig;
  if (!Array.isArray(config.clusters) || config.clusters.length === 0) {
    throw new SearchdexError(`${path} must define a non-empty "clusters" array`);
  }
  return config;
}

/**
 * Flags beat config, config beats nothing. Kept as one function so the
 * precedence rules are readable in one place instead of scattered per-command.
 */
export function resolveClusters(
  config: SearchdexConfig | undefined,
  overrides: { readonly cluster?: string | undefined; readonly projectId?: string | undefined },
): ResolvedCluster[] {
  const fallbackProjectId = overrides.projectId ?? config?.projectId;

  if (overrides.cluster) {
    if (!fallbackProjectId) throw missingProjectId();
    return [{ name: overrides.cluster, projectId: fallbackProjectId }];
  }

  const clusters = config?.clusters ?? [];
  if (clusters.length === 0) {
    throw new SearchdexError('no cluster specified', [
      'Pass --cluster <name> --project-id <id>, or add a searchdex.config.json',
      'with a "clusters" array.',
    ]);
  }

  const resolved = clusters.map((entry) => {
    const name = typeof entry === 'string' ? entry : entry.name;
    const projectId = (typeof entry === 'string' ? undefined : entry.projectId) ?? fallbackProjectId;
    if (!name) throw new SearchdexError('a cluster entry has no name');
    if (!projectId) throw missingProjectId(name);
    return { name, projectId };
  });

  assertUniqueNames(resolved);
  return resolved;
}

/**
 * Cluster names key the fan-out, the summary table and the resume state. Two
 * entries with the same name — the same cluster listed twice, or two projects
 * that happen to name a cluster alike — would silently apply to one of them
 * twice and mark the other complete.
 */
function assertUniqueNames(clusters: readonly ResolvedCluster[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const cluster of clusters) {
    if (seen.has(cluster.name)) duplicates.add(cluster.name);
    seen.add(cluster.name);
  }
  if (duplicates.size > 0) {
    throw new SearchdexError(`duplicate cluster name: ${[...duplicates].join(', ')}`, [
      'Cluster names identify the work in the plan, the summary and the resume',
      'state, so each one must appear once.',
    ]);
  }
}

function missingProjectId(cluster?: string): SearchdexError {
  return new SearchdexError(
    cluster ? `no Atlas project id for cluster "${cluster}"` : 'no Atlas project id',
    ['Pass --project-id <id>, or set "projectId" in searchdex.config.json.'],
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
