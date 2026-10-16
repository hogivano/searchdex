import { keyToString } from '../../domain/index.ts';
import type { Change, ClusterPlan, FieldChange } from '../../domain/index.ts';
import type { ApplyResult, ChangeOutcome } from '../../application/apply.ts';
import type { ClusterOutcome } from '../../application/fan-out.ts';

/**
 * Output aimed at a terminal and at a Slack paste. Plain text, aligned columns,
 * no colour codes — half of these lines end up in a CI log where colour becomes
 * escape-sequence noise.
 */

const SIGILS: Record<Change['kind'], string> = { create: '+', update: '~', delete: '-' };

export function renderPlan(plan: ClusterPlan): string {
  const lines: string[] = ['', `  cluster: ${plan.cluster}`];

  if (plan.changes.length === 0) {
    lines.push('    no changes', '');
    return lines.join('\n');
  }

  for (const change of plan.changes) lines.push(...renderChange(change));
  lines.push('', `  ${summarise(plan)}`, '');
  return lines.join('\n');
}

function renderChange(change: Change): string[] {
  const sigil = SIGILS[change.kind];
  const name = keyToString(change.key);

  if (change.kind === 'create') return [`    ${sigil} ${pad(name)} new index`];
  if (change.kind === 'delete') return [`    ${sigil} ${pad(name)} exists remotely, not in repo`];

  const lines: string[] = [];
  for (const [i, field] of change.fields.entries()) {
    lines.push(`    ${i === 0 ? sigil : ' '} ${i === 0 ? pad(name) : pad('')} ${field.path}`);
    lines.push(...renderFieldValues(field));
  }
  return lines;
}

function renderFieldValues(field: FieldChange): string[] {
  const lines = [
    `                                 deployed  ${format(field.deployed)}`,
    `                                 local     ${format(field.local)}`,
  ];
  if (field.certainty === 'unexplained') {
    lines.push('                                 (present on one side only — see note below)');
  }
  return lines;
}

function format(value: unknown): string {
  if (value === undefined) return '(absent)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function pad(text: string): string {
  return text.padEnd(22);
}

export function summarise(plan: ClusterPlan): string {
  const count = plan.changes.length;
  return `${count} change${count === 1 ? '' : 's'} on ${plan.cluster}.  Run \`searchdex apply\` to converge.`;
}

/**
 * The honesty footer. Printed whenever the diff contains a field we could not
 * confidently classify, because a drift report that hides its own uncertainty is
 * how the tool gets muted.
 */
export function renderUnexplainedNote(): string {
  return [
    '',
    '  Note: fields marked "present on one side only" may be real drift, or may be',
    '  an Atlas default that searchdex has not catalogued. Run `searchdex pull` into',
    '  a scratch directory and compare if you need to be sure.',
    '',
  ].join('\n');
}

export function renderApply(result: ApplyResult): string {
  const lines = ['', `  cluster: ${result.cluster}`];
  for (const outcome of result.outcomes) lines.push(`    ${renderOutcome(outcome)}`);
  lines.push('');
  return lines.join('\n');
}

function renderOutcome(outcome: ChangeOutcome): string {
  const name = keyToString(outcome.change.key);
  switch (outcome.kind) {
    case 'applied': {
      const suffix = outcome.note ? `  (${outcome.note})` : '';
      return `${SIGILS[outcome.change.kind]} ${pad(name)} live after ${seconds(outcome.waitedMs)}${suffix}`;
    }
    case 'accepted':
      return `${SIGILS[outcome.change.kind]} ${pad(name)} accepted by Atlas (not waiting)`;
    case 'skipped':
      return `  ${pad(name)} skipped: ${outcome.reason}`;
    case 'failed':
      return `! ${pad(name)} ${outcome.error.message}`;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Failures, printed whether there is one cluster or eighteen. An earlier version
 * only printed the summary table, so a single-cluster failure exited non-zero
 * with nothing on screen.
 */
export function renderFailures<T>(outcomes: readonly ClusterOutcome<T>[]): string {
  const failures = outcomes.filter((outcome) => outcome.status === 'failed');
  if (failures.length === 0) return '';
  return ['', ...failures.map((failure) => `  ${failure.cluster}: ${failure.error.message}`), ''].join('\n');
}

/** The multi-cluster summary table, sized for a Slack thread. */
export function renderClusterTable<T>(outcomes: readonly ClusterOutcome<T>[]): string {
  const width = Math.max(7, ...outcomes.map((outcome) => outcome.cluster.length));
  const lines = ['', `  ${'cluster'.padEnd(width)}  status`, `  ${'-'.repeat(width)}  ------`];
  for (const outcome of outcomes) {
    lines.push(`  ${outcome.cluster.padEnd(width)}  ${describeClusterOutcome(outcome)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function describeClusterOutcome<T>(outcome: ClusterOutcome<T>): string {
  if (outcome.status === 'ok') return 'ok';
  if (outcome.status === 'skipped') return `skipped (${outcome.reason})`;
  return `failed: ${outcome.error.message}`;
}
