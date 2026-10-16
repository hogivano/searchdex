/**
 * Every flag searchdex accepts, declared once.
 *
 * A parser that guesses whether a token is a value or the next flag will
 * eventually guess wrong, and on this tool a misparsed flag is not cosmetic:
 * `--allow-delete` gates deleting production indexes and `--yes` skips the
 * confirmation that protects it. So the flags are declared and anything
 * undeclared is an error, rather than being silently ignored.
 */

/** Flags that never take a value. `--no-<name>` sets them false. */
export const BOOLEAN_FLAGS = [
  'help',
  'json',
  'quiet',
  'yes',
  'allow-delete',
  'wait',
  'validate',
  'fail-fast',
  'include-vector-search',
] as const;

/** Flags that always take a value. */
export const VALUE_FLAGS = [
  'cluster',
  'project-id',
  'config',
  'dir',
  'base-url',
  'timeout',
  'poll',
  'concurrency',
  'run-id',
  'state-file',
] as const;

export const COMMANDS = ['diff', 'apply', 'drift', 'pull', 'help'] as const;

export type Command = (typeof COMMANDS)[number];

export function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}
