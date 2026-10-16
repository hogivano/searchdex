import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fanOut } from '../../src/application/fan-out.ts';
import { silentReporter } from '../../src/application/ports.ts';

const CLUSTERS = ['a', 'b', 'c', 'd', 'e'];

test('respects the concurrency bound', async () => {
  let inFlight = 0;
  let peak = 0;

  await fanOut(
    CLUSTERS,
    async (cluster) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return cluster;
    },
    { concurrency: 2, failFast: false, completed: new Set() },
    silentReporter,
  );

  assert.equal(peak, 2, `ran ${peak} clusters at once with --concurrency 2`);
});

test('reports outcomes in input order regardless of completion order', async () => {
  const { outcomes } = await fanOut(
    CLUSTERS,
    async (cluster) => {
      await new Promise((resolve) => setTimeout(resolve, cluster === 'a' ? 20 : 1));
      return cluster;
    },
    { concurrency: 5, failFast: false, completed: new Set() },
    silentReporter,
  );

  assert.deepEqual(outcomes.map((outcome) => outcome.cluster), CLUSTERS);
});

test('one cluster failing does not stop the others by default', async () => {
  const { outcomes } = await fanOut(
    CLUSTERS,
    async (cluster) => {
      if (cluster === 'b') throw new Error('Atlas API 500');
      return cluster;
    },
    { concurrency: 1, failFast: false, completed: new Set() },
    silentReporter,
  );

  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['ok', 'failed', 'ok', 'ok', 'ok']);
});

test('--fail-fast skips clusters not yet started', async () => {
  const { outcomes } = await fanOut(
    CLUSTERS,
    async (cluster) => {
      if (cluster === 'b') throw new Error('Atlas API 500');
      return cluster;
    },
    { concurrency: 1, failFast: true, completed: new Set() },
    silentReporter,
  );

  assert.deepEqual(outcomes.map((outcome) => outcome.status), [
    'ok',
    'failed',
    'skipped',
    'skipped',
    'skipped',
  ]);
});

test('a re-run resumes: completed clusters are skipped, not redone', async () => {
  const ran: string[] = [];
  const { outcomes } = await fanOut(
    CLUSTERS,
    async (cluster) => {
      ran.push(cluster);
      return cluster;
    },
    { concurrency: 2, failFast: false, completed: new Set(['a', 'b', 'c']) },
    silentReporter,
  );

  assert.deepEqual(ran.sort(), ['d', 'e']);
  assert.deepEqual(outcomes.slice(0, 3).map((outcome) => outcome.status), [
    'skipped',
    'skipped',
    'skipped',
  ]);
});
