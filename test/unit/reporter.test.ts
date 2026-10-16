import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReporter } from '../../src/presentation/reporter.ts';
import { systemClock } from '../../src/infrastructure/clock.ts';

test('progress lines name the index, the state and the elapsed time', () => {
  const lines: string[] = [];
  const reporter = createReporter({ quiet: false, write: (line) => lines.push(line) });

  reporter.indexStateChanged({
    cluster: 'prod',
    index: 'jobs.job.job_search',
    state: 'BUILDING',
    detail: '1 of 3 hosts still serving an older definition',
    elapsedMs: 12_400,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /jobs\.job\.job_search/);
  assert.match(lines[0]!, /BUILDING \(12s\)/);
  assert.match(lines[0]!, /1 of 3 hosts/);
});

test('a state with no detail renders without a trailing separator', () => {
  const lines: string[] = [];
  const reporter = createReporter({ quiet: false, write: (line) => lines.push(line) });

  reporter.indexStateChanged({ cluster: 'p', index: 'i', state: 'READY', detail: undefined, elapsedMs: 0 });

  assert.match(lines[0]!, /i {2}READY \(0s\)$/);
});

test('cluster start and finish are reported', () => {
  const lines: string[] = [];
  const reporter = createReporter({ quiet: false, write: (line) => lines.push(line) });

  reporter.clusterStarted('eu');
  reporter.clusterFinished('eu', 'ok');
  reporter.clusterFinished('us', 'failed');

  assert.deepEqual(lines, ['  eu: starting', '  eu: ok', '  us: failed']);
});

test('--quiet emits nothing at all', () => {
  const lines: string[] = [];
  const reporter = createReporter({ quiet: true, write: (line) => lines.push(line) });

  reporter.indexStateChanged({ cluster: 'p', index: 'i', state: 'READY', detail: 'x', elapsedMs: 1 });
  reporter.clusterStarted('eu');
  reporter.clusterFinished('eu', 'ok');

  assert.deepEqual(lines, []);
});

test('the system clock advances and its sleep actually waits', async () => {
  const before = systemClock.now();
  await systemClock.sleep(20);
  const waited = systemClock.now() - before;

  assert.ok(waited >= 15, `sleep(20) returned after ${waited}ms`);
});
