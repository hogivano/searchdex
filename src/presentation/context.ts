import { resolve } from 'node:path';
import { AtlasClient } from '../infrastructure/atlas/http.ts';
import { AtlasSearchIndexGateway } from '../infrastructure/atlas/search-index-gateway.ts';
import { loadCredentials } from '../infrastructure/config/credentials.ts';
import { findConfigFile, loadConfigFile, resolveClusters } from '../infrastructure/config/load-config.ts';
import type { ResolvedCluster, SearchdexConfig } from '../infrastructure/config/load-config.ts';
import { FileDefinitionStore } from '../infrastructure/fs/file-definition-store.ts';
import { permissiveValidator, SchemaValidator } from '../infrastructure/validation/schema-validator.ts';
import { systemClock } from '../infrastructure/clock.ts';
import type { Clock, DefinitionStore, DefinitionValidator, ProgressReporter, SearchIndexGateway } from '../application/ports.ts';
import { boolFlag, numberFlag, stringFlag } from './args.ts';
import type { ParsedArgs } from './args.ts';
import { createReporter } from './reporter.ts';

/**
 * The composition root: the one place that knows which concrete adapter backs
 * which port. Everything above this file depends on interfaces, which is what
 * makes the use cases testable against an in-memory Atlas.
 */

export interface CommandContext {
  readonly clusters: readonly ResolvedCluster[];
  readonly store: DefinitionStore;
  readonly validator: DefinitionValidator;
  readonly clock: Clock;
  readonly reporter: ProgressReporter;
  readonly json: boolean;
  readonly concurrency: number;
  gatewayFor(cluster: ResolvedCluster): SearchIndexGateway;
}

export interface ContextOptions {
  /** Read-only commands do not need write credentials, but do need credentials. */
  readonly requireCredentials?: boolean;
  readonly cwd?: string;
  readonly stderr?: (line: string) => void;
}

export async function buildContext(args: ParsedArgs, options: ContextOptions = {}): Promise<CommandContext> {
  const cwd = options.cwd ?? process.cwd();
  const config = await loadConfig(args, cwd);

  const clusters = resolveClusters(config, {
    cluster: stringFlag(args, 'cluster'),
    projectId: stringFlag(args, 'project-id'),
  });

  const directory = resolve(cwd, stringFlag(args, 'dir') ?? config?.directory ?? 'search-indexes');
  const json = boolFlag(args, 'json', false);
  const baseUrl = stringFlag(args, 'base-url') ?? config?.baseUrl;
  const client = new AtlasClient({
    credentials: loadCredentials(),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });

  return {
    clusters,
    store: new FileDefinitionStore(directory),
    validator: boolFlag(args, 'validate', true) ? new SchemaValidator() : permissiveValidator,
    clock: systemClock,
    // JSON output goes to stdout; progress must not corrupt it, so it goes to stderr.
    reporter: createReporter({
      quiet: boolFlag(args, 'quiet', false),
      write: options.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
    }),
    json,
    concurrency: numberFlag(args, 'concurrency', config?.concurrency ?? 3),
    gatewayFor: (cluster) => new AtlasSearchIndexGateway(client, cluster.projectId, cluster.name),
  };
}

async function loadConfig(args: ParsedArgs, cwd: string): Promise<SearchdexConfig | undefined> {
  const explicit = stringFlag(args, 'config');
  const path = explicit ? resolve(cwd, explicit) : await findConfigFile(cwd);
  return path === undefined ? undefined : loadConfigFile(path);
}
