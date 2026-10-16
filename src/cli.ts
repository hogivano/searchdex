#!/usr/bin/env node
import { SearchdexError } from './domain/index.ts';
import { boolFlag, numberFlag, parseArgs, stringFlag } from './presentation/args.ts';
import type { ParsedArgs } from './presentation/args.ts';
import { buildContext } from './presentation/context.ts';
import { runApply } from './presentation/commands/apply.ts';
import { runDiff } from './presentation/commands/diff.ts';
import { runPull } from './presentation/commands/pull.ts';
import { confirmOnTty } from './presentation/confirm.ts';
import { EXIT } from './presentation/exit-codes.ts';
import type { ExitCode } from './presentation/exit-codes.ts';
import { HELP } from './presentation/help.ts';
import { COMMANDS, isCommand } from './presentation/flags.ts';

/**
 * Argument parsing, dispatch, and turning errors into exit codes. Everything
 * else lives a layer down — this file should stay boring enough to read in one
 * sitting.
 */
async function main(argv: readonly string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  const out = (text: string): void => void process.stdout.write(`${text}\n`);

  if (args.command === undefined || args.command === 'help' || boolFlag(args, 'help', false)) {
    out(HELP);
    return EXIT.OK;
  }

  if (!isCommand(args.command)) {
    throw new SearchdexError(`unknown command "${args.command}"`, [
      `Expected one of: ${COMMANDS.join(', ')}.`,
      'Run `searchdex help` for the full usage.',
    ]);
  }

  switch (args.command) {
    case 'diff':
      return runDiff(await buildContext(args), { failOnChanges: false }, out);
    case 'drift':
      return runDiff(await buildContext(args), { failOnChanges: true }, out);
    case 'pull':
      return runPull(
        await buildContext(args),
        { includeVectorSearch: boolFlag(args, 'include-vector-search', false) },
        out,
      );
    case 'apply':
      return runApply(await buildContext(args), applyOptions(args), { out, confirm: confirmOnTty });
    default:
      // `help` is handled above; the switch is exhaustive over the rest.
      out(HELP);
      return EXIT.OK;
  }
}

function applyOptions(args: ParsedArgs) {
  return {
    yes: boolFlag(args, 'yes', false),
    allowDelete: boolFlag(args, 'allow-delete', false),
    wait: boolFlag(args, 'wait', true),
    timeoutMs: numberFlag(args, 'timeout', 600) * 1000,
    pollIntervalMs: numberFlag(args, 'poll', 5) * 1000,
    failFast: boolFlag(args, 'fail-fast', false),
    runId: stringFlag(args, 'run-id'),
    stateFile: stringFlag(args, 'state-file') ?? '.searchdex/run-state.json',
  };
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof SearchdexError) {
    process.stderr.write(`\n  error: ${error.message}\n`);
    for (const line of error.details) process.stderr.write(`  ${line}\n`);
    process.stderr.write('\n');
  } else {
    // Not a failure we anticipated. Show the stack — hiding it helps nobody.
    process.stderr.write(`\n  unexpected error\n`);
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n\n`);
  }
  process.exitCode = EXIT.ERROR;
}
