import { mkdir, rename, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Which clusters a fan-out has already finished, so a re-run resumes.
 *
 * Deliberately not a lock file and not a Terraform-style state file: it records
 * nothing about *what* is deployed — Atlas is the only source of truth for that.
 * It records only "cluster X completed during run Y", and losing it costs you a
 * re-diff, never correctness.
 */
export interface RunState {
  readonly runId: string;
  readonly startedAt: string;
  readonly completed: string[];
}

export class RunStateStore {
  readonly #file: string;
  /** Serialises writes: concurrent completions must not overwrite each other. */
  #pending: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async load(runId: string): Promise<RunState> {
    const raw = await readFile(this.#file, 'utf8').catch(() => undefined);
    if (raw === undefined) return freshState(runId);
    try {
      const parsed = JSON.parse(raw) as Partial<RunState>;
      // A state file from a different run describes different work. Resuming
      // from it would skip clusters that were never touched by this run.
      if (parsed.runId !== runId || !Array.isArray(parsed.completed)) return freshState(runId);
      return {
        runId,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : new Date().toISOString(),
        completed: parsed.completed.filter((entry): entry is string => typeof entry === 'string'),
      };
    } catch {
      // A truncated or hand-edited file costs a re-diff, not a failed run.
      return freshState(runId);
    }
  }

  /**
   * Mark one cluster complete and persist.
   *
   * The mutation happens synchronously, before any `await`, so two clusters
   * finishing at the same moment both land in the array; the write itself is
   * queued behind any write already in flight so the last file on disk is the
   * complete one. Doing it the obvious way — build a new array, then await the
   * write — loses whichever completion was recorded during the other's I/O.
   */
  async record(state: RunState, cluster: string): Promise<void> {
    if (state.completed.includes(cluster)) return;
    state.completed.push(cluster);
    await this.save(state);
  }

  async save(state: RunState): Promise<void> {
    this.#pending = this.#pending.then(() => this.#write(state));
    await this.#pending;
  }

  /** Write via a temp file and rename, so a crash cannot leave half a file. */
  async #write(state: RunState): Promise<void> {
    const directory = dirname(this.#file);
    await mkdir(directory, { recursive: true });
    const temp = join(directory, `.${process.pid}.run-state.tmp`);
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, this.#file);
  }
}

function freshState(runId: string): RunState {
  return { runId, startedAt: new Date().toISOString(), completed: [] };
}
