import { createInterface } from 'node:readline/promises';

/**
 * Confirmation for a command that changes production search.
 *
 * Without a tty there is nobody to ask, so we refuse rather than assume yes —
 * `--yes` is how a pipeline says it meant it.
 */
export async function confirmOnTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write('  refusing to apply without confirmation: no tty. Pass --yes to proceed.\n');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return isAffirmative(await rl.question(`  ${question} [y/N] `));
  } finally {
    rl.close();
  }
}

/**
 * Only "y" or "yes" is consent. Anything else — including an empty line, which
 * is what pressing return gives you — is a no, because the default for a command
 * that rewrites production search has to be "don't".
 */
export function isAffirmative(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}
