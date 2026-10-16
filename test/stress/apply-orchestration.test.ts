import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { runApply } from '../../src/presentation/commands/apply.ts';
import { EXIT } from '../../src/presentation/exit-codes.ts';
import { captureOut, testContext } from '../fixtures/context.ts';

/**
 * The command layer across several clusters: how many times a user is asked,
 * what happens when one cluster fails, and whether a resumed run redoes work.
 */

const OPTIONS = {
  yes: false,
  allowDelete: false,
  wait: true,
  timeoutMs: 60_000,
  pollIntervalMs: 1_000,
  failFast: false,
  runId: 'run-1',
  stateFile: '',
};

async function withDefinition(clusters: string[], concurrency = 3) {
  const context = await testContext(clusters, { concurrency });
  await writeFile(join(context.dir, 'jobs.job.job_search.json'), '{"mappings":{"dynamic":true}}');
  // Outside the definitions directory, mirroring the real default of
  // .searchdex/run-state.json — a stray .json file in search-indexes/ is an
  // error, by design, and the state file must not become one.
  return { context, stateFile: join(context.stateDir, 'run-state.json') };
}

test('the user is asked exactly once, no matter how many clusters', async () => {
  const { context, stateFile } = await withDefinition(['eu', 'us', 'ap'], 3);
  const io = captureOut();
  const questions: string[] = [];

  const code = await runApply(
    context,
    { ...OPTIONS, stateFile },
    {
      out: io.out,
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    },
  );

  assert.equal(code, EXIT.OK);
  assert.equal(questions.length, 1, `asked ${questions.length} times: ${questions.join(' / ')}`);
  assert.match(questions[0]!, /3 changes to 3 clusters \(eu, us, ap\)/);
});

test('the plan for every cluster is shown before anything is applied', async () => {
  const { context, stateFile } = await withDefinition(['eu', 'us']);
  const io = captureOut();
  let planShownWhenAsked = '';

  await runApply(
    context,
    { ...OPTIONS, stateFile },
    {
      out: io.out,
      confirm: async () => {
        planShownWhenAsked = io.text();
        return true;
      },
    },
  );

  assert.match(planShownWhenAsked, /cluster: eu/);
  assert.match(planShownWhenAsked, /cluster: us/);
});

test('declining applies nothing, and exits non-zero so CI does not read it as success', async () => {
  const { context, stateFile } = await withDefinition(['eu', 'us']);
  const io = captureOut();

  const code = await runApply(context, { ...OPTIONS, stateFile }, { out: io.out, confirm: async () => false });

  assert.equal(code, EXIT.CHANGES);
  for (const [name, atlas] of context.atlas) {
    assert.equal((await atlas.list()).length, 0, `${name} was modified despite the abort`);
  }
});

test('one cluster failing still applies the others, and reports both', async () => {
  const { context, stateFile } = await withDefinition(['eu', 'us', 'ap'], 1);
  const broken = context.atlas.get('us')!;
  broken.create = async () => {
    throw new Error('Atlas API 403: insufficient permissions');
  };

  const io = captureOut();
  const code = await runApply(context, { ...OPTIONS, yes: true, stateFile }, { out: io.out, confirm: async () => true });

  assert.equal(code, EXIT.ERROR);
  assert.equal((await context.atlas.get('eu')!.list()).length, 1);
  assert.equal((await context.atlas.get('ap')!.list()).length, 1);
  assert.match(io.text(), /insufficient permissions/);
  assert.match(io.text(), /--run-id run-1 to resume/);
});

test('a resumed run skips clusters that already succeeded', async () => {
  const { context, stateFile } = await withDefinition(['eu', 'us', 'ap'], 1);
  const broken = context.atlas.get('ap')!;
  const realCreate = broken.create.bind(broken);
  broken.create = async () => {
    throw new Error('Atlas API 500');
  };

  const io = captureOut();
  await runApply(context, { ...OPTIONS, yes: true, stateFile }, { out: io.out, confirm: async () => true });
  assert.equal((await broken.list()).length, 0);

  // Second run, same run id: eu and us are done, only ap should be touched.
  broken.create = realCreate;
  const before = {
    eu: context.atlas.get('eu')!.calls.length,
    us: context.atlas.get('us')!.calls.length,
  };

  const code = await runApply(
    context,
    { ...OPTIONS, yes: true, stateFile },
    { out: captureOut().out, confirm: async () => true },
  );

  assert.equal(code, EXIT.OK);
  assert.equal((await broken.list()).length, 1, 'the failed cluster was not retried');
  assert.equal(context.atlas.get('eu')!.calls.length, before.eu, 'a completed cluster was re-planned');
  assert.equal(context.atlas.get('us')!.calls.length, before.us, 'a completed cluster was re-planned');
});

test('a cluster whose apply partially failed is not recorded as complete', async () => {
  const { context, stateFile } = await withDefinition(['eu']);
  await writeFile(join(context.dir, 'jobs.job.other.json'), '{"mappings":{"dynamic":true}}');

  const atlas = context.atlas.get('eu')!;
  const realCreate = atlas.create.bind(atlas);
  let first = true;
  atlas.create = async (index) => {
    if (first) {
      first = false;
      throw new Error('Atlas API 400');
    }
    return realCreate(index);
  };

  await runApply(
    context,
    { ...OPTIONS, yes: true, stateFile },
    { out: captureOut().out, confirm: async () => true },
  );

  // Re-running must retry the index that failed, so the cluster must not have
  // been marked done just because the run reached the end.
  const io = captureOut();
  const code = await runApply(
    context,
    { ...OPTIONS, yes: true, stateFile },
    { out: io.out, confirm: async () => true },
  );

  assert.equal(code, EXIT.OK);
  assert.equal((await atlas.list()).length, 2, 'the failed index was never retried');
});

test('nothing to do exits 0 without asking anything', async () => {
  const context = await testContext(['eu']);
  const io = captureOut();
  let asked = false;

  const code = await runApply(
    context,
    { ...OPTIONS, stateFile: join(context.stateDir, 'run-state.json') },
    {
      out: io.out,
      confirm: async () => {
        asked = true;
        return true;
      },
    },
  );

  assert.equal(code, EXIT.OK);
  assert.equal(asked, false, 'asked for confirmation with no changes to make');
});

test('--json emits one parseable document even across clusters', async () => {
  const { context, stateFile } = await withDefinition(['eu', 'us']);
  const json = { ...context, json: true };
  const io = captureOut();

  await runApply(json, { ...OPTIONS, yes: true, stateFile }, { out: io.out, confirm: async () => true });

  const parsed = JSON.parse(io.text()) as { runId: string; clusters: unknown[] };
  assert.equal(parsed.runId, 'run-1');
  assert.equal(parsed.clusters.length, 2);
});
