import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../src/presentation/context.ts';
import { FileDefinitionStore } from '../../src/infrastructure/fs/file-definition-store.ts';
import { permissiveValidator } from '../../src/infrastructure/validation/schema-validator.ts';
import { silentReporter } from '../../src/application/ports.ts';
import { fakeClock, FakeAtlas } from './fake-atlas.ts';
import type { FakeIndexOptions } from './fake-atlas.ts';

/**
 * A CommandContext wired to in-memory clusters. Lets the command layer — the
 * orchestration, the confirmation, the exit codes — be tested without a network
 * or a config file.
 */
export interface TestContext extends CommandContext {
  /** The definitions directory. */
  readonly dir: string;
  /** A separate directory for run state, as in a real project. */
  readonly stateDir: string;
  readonly atlas: ReadonlyMap<string, FakeAtlas>;
}

export async function testContext(
  clusterNames: readonly string[],
  options: {
    readonly json?: boolean;
    readonly concurrency?: number;
    readonly atlas?: FakeIndexOptions;
  } = {},
): Promise<TestContext> {
  const dir = await mkdtemp(join(tmpdir(), 'searchdex-ctx-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'searchdex-state-'));
  const atlas = new Map(
    clusterNames.map((name) => [name, new FakeAtlas(name, options.atlas ?? {})] as const),
  );

  return {
    dir,
    stateDir,
    atlas,
    clusters: clusterNames.map((name) => ({ name, projectId: 'group123' })),
    store: new FileDefinitionStore(dir),
    validator: permissiveValidator,
    clock: fakeClock(),
    reporter: silentReporter,
    json: options.json ?? false,
    concurrency: options.concurrency ?? 3,
    gatewayFor: (cluster) => {
      const gateway = atlas.get(cluster.name);
      if (!gateway) throw new Error(`test setup: no fake cluster named ${cluster.name}`);
      return gateway;
    },
  };
}

/** Collects CLI output so a test can assert on what a user would have seen. */
export function captureOut(): { lines: string[]; out: (text: string) => void; text(): string } {
  const lines: string[] = [];
  return {
    lines,
    out: (text) => lines.push(text),
    text: () => lines.join('\n'),
  };
}
