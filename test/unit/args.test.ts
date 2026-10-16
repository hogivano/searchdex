import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boolFlag, numberFlag, parseArgs, stringFlag } from '../../src/presentation/args.ts';

/**
 * The parser is small, which is exactly why it needs the awkward cases written
 * down: every silent misparse here becomes a flag that looks applied and is not,
 * and one of those flags gates deleting production indexes.
 */

test('separates the command from flags and positionals', () => {
  const args = parseArgs(['diff', '--cluster', 'prod', 'extra']);
  assert.equal(args.command, 'diff');
  assert.equal(stringFlag(args, 'cluster'), 'prod');
  assert.deepEqual(args.positionals, ['extra']);
});

test('accepts --flag=value and -flag value alike', () => {
  const args = parseArgs(['diff', '--cluster=prod', '-project-id', '123']);
  assert.equal(stringFlag(args, 'cluster'), 'prod');
  assert.equal(stringFlag(args, 'project-id'), '123');
});

test('--no-x sets x false', () => {
  const args = parseArgs(['apply', '--no-wait', '--no-validate']);
  assert.equal(boolFlag(args, 'wait', true), false);
  assert.equal(boolFlag(args, 'validate', true), false);
});

test('a bare flag before another flag is boolean, not a value', () => {
  const args = parseArgs(['apply', '--yes', '--cluster', 'prod']);
  assert.equal(boolFlag(args, 'yes', false), true);
  assert.equal(stringFlag(args, 'cluster'), 'prod');
});

test('a value that looks like a flag must be passed with =', () => {
  const args = parseArgs(['diff', '--cluster=--weird']);
  assert.equal(stringFlag(args, 'cluster'), '--weird');

  // ...and writing it the other way is an error, not a silent misparse.
  assert.throws(() => parseArgs(['diff', '--cluster', '--weird']), /--cluster requires a value/);
});

test('an empty --flag= value is preserved, not treated as absent', () => {
  const args = parseArgs(['diff', '--cluster=']);
  assert.equal(stringFlag(args, 'cluster'), '');
});

test('the last occurrence of a repeated flag wins', () => {
  const args = parseArgs(['diff', '--cluster', 'a', '--cluster', 'b']);
  assert.equal(stringFlag(args, 'cluster'), 'b');
});

test('numberFlag rejects values that are not positive numbers', () => {
  for (const value of ['0', '-5', 'abc', 'NaN', 'Infinity', '']) {
    assert.throws(
      () => numberFlag(parseArgs(['apply', `--timeout=${value}`]), 'timeout', 600),
      /--timeout must be a positive number/,
      `accepted --timeout=${value}`,
    );
  }
});

test('numberFlag accepts a fractional value', () => {
  assert.equal(numberFlag(parseArgs(['apply', '--poll=0.5']), 'poll', 5), 0.5);
});

test('a value flag given no value is an error, not a silent fallback', () => {
  assert.throws(() => parseArgs(['apply', '--timeout']), /--timeout requires a value/);
});

test('an unknown flag is refused, with the likely intent named', () => {
  assert.throws(() => parseArgs(['apply', '--alow-delete']), (error: Error) => {
    assert.match(error.message, /unknown flag --alow-delete/);
    assert.match((error as { details: string[] }).details.join(' '), /--allow-delete/);
    return true;
  });
});

test('a typo in a safety flag cannot be silently ignored', () => {
  // The failure this prevents: --allow-deletes looking like it worked.
  for (const typo of ['--allow-deletes', '--yess', '--jsonn', '--dryrun']) {
    assert.throws(() => parseArgs(['apply', typo]), /unknown flag/, `accepted ${typo}`);
  }
});

test('--no- on a value flag is not a boolean', () => {
  assert.throws(() => parseArgs(['diff', '--no-cluster']), /unknown flag --no-cluster/);
});

test('boolFlag treats an explicit "false" string as false', () => {
  assert.equal(boolFlag(parseArgs(['apply', '--wait=false']), 'wait', true), false);
  assert.equal(boolFlag(parseArgs(['apply', '--wait=true']), 'wait', false), true);
});

test('an empty argv yields no command', () => {
  const args = parseArgs([]);
  assert.equal(args.command, undefined);
});

test('a boolean flag never swallows the command after it', () => {
  // The bug this pins: `searchdex --json diff` used to parse json="diff" and
  // then print the help text, because the parser guessed greedily.
  for (const argv of [['--json', 'diff'], ['--quiet', 'drift'], ['--yes', 'apply']]) {
    const args = parseArgs(argv);
    assert.equal(args.command, argv[1], `lost the command after ${argv[0]}`);
    assert.equal(boolFlag(args, argv[0]!.slice(2), false), true);
  }
});

test('a lone "-" is a positional, not a flag', () => {
  const args = parseArgs(['diff', '-']);
  assert.deepEqual(args.positionals, ['-']);
});
