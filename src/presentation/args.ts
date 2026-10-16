import { SearchdexError } from '../domain/index.ts';
import { BOOLEAN_FLAGS, VALUE_FLAGS } from './flags.ts';

/**
 * A small argv parser instead of a dependency. Four commands and a dozen flags
 * do not justify a framework, and hand-rolling it keeps the help text and the
 * parser in the same place, where they cannot disagree.
 *
 * It is strict on purpose. An unknown flag is an error rather than a no-op,
 * because the alternative is `--alow-delete` looking like it worked, and a
 * boolean flag never swallows the token after it, because `--json diff` must
 * still run `diff`.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly positionals: readonly string[];
}

const BOOLEANS = new Set<string>(BOOLEAN_FLAGS);
const VALUES = new Set<string>(VALUE_FLAGS);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (!token.startsWith('-') || token === '-') {
      if (command === undefined) command = token;
      else positionals.push(token);
      continue;
    }

    const body = token.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (name.startsWith('no-') && BOOLEANS.has(name.slice(3))) {
      if (inlineValue !== undefined) {
        throw new SearchdexError(`--${name} does not take a value`, [
          `Use --${name} on its own, or --${name.slice(3)}=${inlineValue}.`,
        ]);
      }
      flags.set(name.slice(3), false);
      continue;
    }

    if (BOOLEANS.has(name)) {
      flags.set(name, inlineValue === undefined ? true : inlineValue !== 'false');
      continue;
    }

    if (VALUES.has(name)) {
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
        continue;
      }
      const next = argv[i + 1];
      // A value beginning with "-" has to be written --flag=-value, otherwise
      // there is no way to tell it from the next flag.
      if (next === undefined || next.startsWith('-')) {
        throw new SearchdexError(`--${name} requires a value`, [
          `Write --${name} <value>, or --${name}=<value> if the value starts with "-".`,
        ]);
      }
      flags.set(name, next);
      i += 1;
      continue;
    }

    throw new SearchdexError(`unknown flag --${name}`, suggest(name));
  }

  return { command, flags, positionals };
}

/** A typo in a flag is common and cheap to catch; say the likely intent. */
function suggest(name: string): string[] {
  const known = [...BOOLEANS, ...VALUES];
  const close = known.filter((candidate) => editDistance(candidate, name) <= 2).sort();
  return close.length > 0
    ? [`Did you mean ${close.map((candidate) => `--${candidate}`).join(' or ')}?`]
    : ['Run `searchdex help` for the full list.'];
}

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
    }
  }
  return rows[a.length]![b.length]!;
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined || typeof value === 'boolean') return undefined;
  return value;
}

export function boolFlag(args: ParsedArgs, name: string, fallback: boolean): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value !== 'false';
}

export function numberFlag(args: ParsedArgs, name: string, fallback: number): number {
  const value = stringFlag(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SearchdexError(`--${name} must be a positive number, got "${value}"`);
  }
  return parsed;
}
