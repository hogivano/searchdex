import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmOnTty } from '../../src/presentation/confirm.ts';

/**
 * The prompt guarding every write to production search. The tty branch needs a
 * pty to drive, so the interactive parsing is tested through the exported
 * answer reader; what is tested here is the branch that decides whether to ask
 * at all — the one CI actually hits.
 */

async function withStdin<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const original = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
  }
}

test('without a tty it refuses rather than assuming yes', async () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const answer = await withStdin(false, () => confirmOnTty('Apply 3 changes?'));
    assert.equal(answer, false);
    assert.match(written.join(''), /no tty. Pass --yes to proceed/);
  } finally {
    process.stderr.write = original;
  }
});

test('only an explicit yes counts as consent', async () => {
  const { isAffirmative } = await import('../../src/presentation/confirm.ts');

  for (const yes of ['y', 'Y', 'yes', 'YES', ' yes ', 'Yes']) {
    assert.equal(isAffirmative(yes), true, `rejected "${yes}"`);
  }
  for (const no of ['', ' ', 'n', 'no', 'nope', 'yeah', 'sure', 'ok', 'yy', 'y!', '1', 'true']) {
    assert.equal(isAffirmative(no), false, `accepted "${no}" as consent`);
  }
});
