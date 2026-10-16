import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAtlasServer } from '../fixtures/atlas-server.ts';

/**
 * Dispatch, help and the error surface: what a user sees when they mistype
 * something, and what a pipeline gets back.
 */
const run = promisify(execFile);
const CLI = new URL('../../src/cli.ts', import.meta.url).pathname;
const CREDENTIALS = { publicKey: 'testpublic', privateKey: 'testprivate' };

const servers: { close(): Promise<void> }[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

async function searchdex(args: string[], env: Record<string, string> = {}) {
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

test('no arguments prints help and exits 0', async () => {
  const result = await searchdex([]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /searchdex — Atlas Search index definitions/);
});

test('--help and `help` agree', async () => {
  const viaFlag = await searchdex(['diff', '--help']);
  const viaCommand = await searchdex(['help']);
  assert.equal(viaFlag.stdout, viaCommand.stdout);
  assert.equal(viaFlag.code, 0);
});

test('the help text documents every flag the parser accepts', async () => {
  const { stdout } = await searchdex(['help']);
  const { BOOLEAN_FLAGS, VALUE_FLAGS } = await import('../../src/presentation/flags.ts');

  for (const flag of [...BOOLEAN_FLAGS, ...VALUE_FLAGS]) {
    if (flag === 'help') continue;
    assert.ok(stdout.includes(`--${flag}`), `--${flag} is accepted but undocumented`);
  }
});

test('an unknown command names the ones that exist', async () => {
  const result = await searchdex(['diffs']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown command "diffs"/);
  assert.match(result.stderr, /diff, apply, drift, pull/);
});

test('an unknown flag is refused before anything touches Atlas', async () => {
  const result = await searchdex(['diff', '--clustr', 'prod']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown flag --clustr/);
  assert.match(result.stderr, /Did you mean --cluster/);
});

test('a bad --timeout is refused with the value quoted back', async () => {
  const result = await searchdex(['apply', '--timeout=-1', '--cluster', 'c', '--project-id', 'p'], {
    ATLAS_PUBLIC_KEY: 'x',
    ATLAS_PRIVATE_KEY: 'y',
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--timeout must be a positive number, got "-1"/);
});

test('errors go to stderr and leave stdout clean for --json consumers', async () => {
  const result = await searchdex(['diff', '--cluster', 'c', '--project-id', 'p', '--json'], {
    ATLAS_PUBLIC_KEY: '',
    ATLAS_PRIVATE_KEY: '',
  });
  assert.equal(result.code, 2);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /missing Atlas API credentials/);
});

test('an expected error prints no stack trace', async () => {
  const result = await searchdex(['diff', '--cluster', 'c', '--project-id', 'p'], {
    ATLAS_PUBLIC_KEY: '',
    ATLAS_PRIVATE_KEY: '',
  });
  assert.equal(result.stderr.includes('at '), false, `printed a stack:\n${result.stderr}`);
});

test('--no-validate skips schema validation and reaches the network', async () => {
  const server = await startAtlasServer(CREDENTIALS);
  servers.push(server);
  const dir = await mkdtemp(join(tmpdir(), 'searchdex-novalidate-'));
  await writeFile(join(dir, 'jobs.job.x.json'), '{"mappings":{"dynamic":"not a boolean"}}');

  const args = ['--base-url', server.url, '--project-id', 'g', '--cluster', 'c', '--dir', dir, '--quiet'];
  const env = { ATLAS_PUBLIC_KEY: CREDENTIALS.publicKey, ATLAS_PRIVATE_KEY: CREDENTIALS.privateKey };

  assert.equal((await searchdex(['diff', ...args], env)).code, 2, 'validation should reject this');
  assert.equal((await searchdex(['diff', '--no-validate', ...args], env)).code, 0);
});

test('an unreachable cluster exits 2, not 1 — a network failure is not drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'searchdex-unreachable-'));
  const result = await searchdex(
    ['drift', '--base-url', 'http://127.0.0.1:1', '--project-id', 'g', '--cluster', 'c', '--dir', dir, '--quiet'],
    { ATLAS_PUBLIC_KEY: 'x', ATLAS_PRIVATE_KEY: 'y' },
  );

  assert.equal(result.code, 2);
  assert.match(result.stdout + result.stderr, /c: fetch failed/);
});
