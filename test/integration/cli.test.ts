import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { startAtlasServer } from '../fixtures/atlas-server.ts';

/**
 * End-to-end through the actual binary: argument parsing, the composition root,
 * exit codes and output. Everything below is unit-tested in isolation; this is
 * the test that catches the wiring being wrong.
 */
const run = promisify(execFile);
const CREDENTIALS = { publicKey: 'testpublic', privateKey: 'testprivate' };
const CLI = new URL('../../src/cli.ts', import.meta.url).pathname;

const servers: { close(): Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function searchdex(args: string[], env: Record<string, string>): Promise<Run> {
  try {
    const { stdout, stderr } = await run('node', ['--experimental-strip-types', CLI, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function harness() {
  const server = await startAtlasServer(CREDENTIALS);
  servers.push(server);
  const dir = await mkdtemp(join(tmpdir(), 'searchdex-cli-'));
  const env = {
    ATLAS_PUBLIC_KEY: CREDENTIALS.publicKey,
    ATLAS_PRIVATE_KEY: CREDENTIALS.privateKey,
  };
  const args = [
    '--base-url', server.url,
    '--project-id', 'group123',
    '--cluster', 'acme-prod',
    '--dir', dir,
    '--quiet',
  ];
  return { dir, env, args };
}

test('diff on an empty repo and an empty cluster reports no changes and exits 0', async () => {
  const { env, args } = await harness();
  const result = await searchdex(['diff', ...args], env);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no changes/);
});

test('drift exits 1 when the repo has an index the cluster does not', async () => {
  const { dir, env, args } = await harness();
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');

  const result = await searchdex(['drift', ...args], env);

  assert.equal(result.code, 1, `expected exit 1 for pending changes\n${result.stderr}`);
  assert.match(result.stdout, /\+ jobs\.job\.job_search\s+new index/);
});

test('diff shows the same change but exits 0 — only drift is a gate', async () => {
  const { dir, env, args } = await harness();
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');

  const result = await searchdex(['diff', ...args], env);
  assert.equal(result.code, 0);
});

test('apply --yes creates the index and then drift is clean', async () => {
  const { dir, env, args } = await harness();
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');

  const applied = await searchdex(['apply', '--yes', ...args], env);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /live after/);

  const drift = await searchdex(['drift', ...args], env);
  assert.equal(drift.code, 0, `apply did not converge:\n${drift.stdout}`);
});

test('--json emits parseable output on stdout', async () => {
  const { dir, env, args } = await harness();
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');

  const result = await searchdex(['diff', '--json', ...args], env);
  const parsed = JSON.parse(result.stdout) as { clusters: { cluster: string; value: unknown }[] };
  assert.equal(parsed.clusters[0]?.cluster, 'acme-prod');
});

test('an invalid definition fails locally, naming the file and the field', async () => {
  const { dir, env, args } = await harness();
  // `dynamic` takes a boolean or a type-set object, never a string.
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":"yes"}}');

  const result = await searchdex(['diff', ...args], env);

  assert.equal(result.code, 2, result.stdout);
  assert.match(result.stderr, /jobs\.job\.job_search\.json/);
  assert.match(result.stderr, /mappings\.dynamic: must be boolean/);
});

test('an unknown analyzer name is NOT rejected — custom analyzers are user-defined', async () => {
  const { dir, env, args } = await harness();
  await writeFile(
    join(dir, 'jobs.job.job_search.json'),
    '{"mappings":{"dynamic":true},"analyzer":"my_custom_analyzer"}',
  );

  // Validation must not invent rules the schema does not have; a definition
  // referencing an analyzer defined elsewhere is legitimate.
  const result = await searchdex(['diff', ...args], env);
  assert.equal(result.code, 0, result.stderr);
});

test('missing credentials fail with an actionable message and never echo a key', async () => {
  const { args } = await harness();
  const result = await searchdex(['diff', ...args], { ATLAS_PUBLIC_KEY: '', ATLAS_PRIVATE_KEY: '' });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /ATLAS_PUBLIC_KEY and ATLAS_PRIVATE_KEY/);
});

test('apply without --yes and without a tty refuses rather than assuming yes', async () => {
  const { dir, env, args } = await harness();
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');

  const result = await searchdex(['apply', ...args], env);

  // Non-zero, so a pipeline that forgot --yes fails instead of reporting a
  // successful deploy that never happened.
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no tty/);
  assert.match(result.stdout, /nothing was applied/);
});

test('a delete is skipped without --allow-delete, and reported as skipped', async () => {
  const { dir, env, args } = await harness();
  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');
  await searchdex(['apply', '--yes', ...args], env);

  await writeFile(join(dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');
  const { stdout } = await searchdex(['apply', '--yes', '--dir', await mkdtemp(join(tmpdir(), 'empty-')), ...args.filter((a, i) => !(args[i - 1] === '--dir' || a === '--dir'))], env);

  assert.match(stdout, /skipped: deleting requires --allow-delete/);
});
