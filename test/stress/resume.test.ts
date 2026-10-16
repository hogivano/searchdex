import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fanOut } from '../../src/application/fan-out.ts';
import { silentReporter } from '../../src/application/ports.ts';
import { RunStateStore } from '../../src/infrastructure/fs/run-state-store.ts';
import type { RunState } from '../../src/infrastructure/fs/run-state-store.ts';

/**
 * Resume is the reason fan-out keeps state at all, so the state has to survive
 * the conditions it exists for: several clusters finishing at once, a crash
 * partway through, and a second process reading what the first wrote.
 */

async function stateFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'searchdex-state-')), 'run-state.json');
}

test('every cluster that completes is recorded, even when they finish together', async () => {
  const file = await stateFile();
  const store = new RunStateStore(file);
  const runId = 'run-1';
  const state = await store.load(runId);
  const clusters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  await fanOut(
    clusters,
    async (cluster) => {
      // Finish at the same moment, which is what a fan-out across healthy
      // clusters actually looks like.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return cluster;
    },
    { concurrency: 8, failFast: false, completed: new Set(state.completed) },
    silentReporter,
    async (outcome) => {
      if (outcome.status !== 'ok') return;
      await store.record(state, outcome.cluster);
    },
  );

  const persisted = JSON.parse(await readFile(file, 'utf8')) as RunState;
  assert.deepEqual(
    [...persisted.completed].sort(),
    clusters,
    'a completed cluster was lost from the state file, so a resume would redo it',
  );
});

test('a resumed run skips exactly what the previous run finished', async () => {
  const file = await stateFile();
  const store = new RunStateStore(file);
  const clusters = ['a', 'b', 'c', 'd'];

  // First run: 'c' fails, so 'a', 'b' and 'd' complete.
  const first = await store.load('run-1');
  await fanOut(
    clusters,
    async (cluster) => {
      if (cluster === 'c') throw new Error('Atlas API 500');
      return cluster;
    },
    { concurrency: 2, failFast: false, completed: new Set(first.completed) },
    silentReporter,
    async (outcome) => {
      if (outcome.status === 'ok') await store.record(first, outcome.cluster);
    },
  );

  // Second run, same run id: only 'c' should actually run.
  const second = await store.load('run-1');
  const ran: string[] = [];
  const { outcomes } = await fanOut(
    clusters,
    async (cluster) => {
      ran.push(cluster);
      return cluster;
    },
    { concurrency: 2, failFast: false, completed: new Set(second.completed) },
    silentReporter,
  );

  assert.deepEqual(ran, ['c']);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['skipped', 'skipped', 'ok', 'skipped'],
  );
});

test('a state file from a different run is ignored, not resumed from', async () => {
  const file = await stateFile();
  const store = new RunStateStore(file);
  const first = await store.load('run-1');
  await store.record(first, 'a');

  const other = await store.load('run-2');
  assert.deepEqual(other.completed, [], 'resumed a different run, which would skip real work');
});

test('a corrupt state file degrades to a fresh run rather than crashing', async () => {
  const file = await stateFile();
  const store = new RunStateStore(file);
  await store.save({ runId: 'run-1', startedAt: new Date().toISOString(), completed: ['a'] });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{ this is not json');

  const state = await store.load('run-1');
  assert.deepEqual(state.completed, []);
});

test('recording is idempotent, so a re-recorded cluster does not duplicate', async () => {
  const file = await stateFile();
  const store = new RunStateStore(file);
  const state = await store.load('run-1');

  await store.record(state, 'a');
  await store.record(state, 'a');

  const persisted = JSON.parse(await readFile(file, 'utf8')) as RunState;
  assert.deepEqual(persisted.completed, ['a']);
});
