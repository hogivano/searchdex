import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Start and stop `mongodb/mongodb-atlas-local` via docker. Deliberately shells
 * out rather than depending on a library: the container is the contract, and one
 * `docker run` line is easier to audit than a wrapper.
 */
const run = promisify(execFile);

export interface LocalAtlas {
  readonly uri: string;
  stop(): Promise<void>;
}

export async function startAtlasLocal(name = `searchdex-e2e-${process.pid}`): Promise<LocalAtlas> {
  await run('docker', [
    'run', '--rm', '-d',
    '--name', name,
    '-P',
    'mongodb/mongodb-atlas-local:latest',
  ]);

  const { stdout } = await run('docker', ['port', name, '27017/tcp']);
  const port = stdout.trim().split('\n')[0]!.split(':').pop();

  const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  await waitForHealthy(name);
  return { uri, stop: async () => void (await run('docker', ['stop', name]).catch(() => {})) };
}

/** The container reports readiness itself; polling its healthcheck beats a sleep. */
async function waitForHealthy(name: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { stdout } = await run('docker', [
      'inspect', '-f', '{{.State.Health.Status}}', name,
    ]).catch(() => ({ stdout: 'starting' }));
    if (stdout.trim() === 'healthy') return;
    if (Date.now() > deadline) throw new Error(`${name} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
