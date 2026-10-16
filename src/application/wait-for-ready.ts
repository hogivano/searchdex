import { ReadinessTimeoutError, IndexBuildFailedError, keyToString } from '../domain/index.ts';
import type { IndexKey } from '../domain/index.ts';
import { assess } from '../domain/readiness.ts';
import type { Clock, ProgressReporter, SearchIndexGateway } from './ports.ts';

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  /** Definition version this apply pushed, when Atlas reported one. */
  readonly targetVersion?: number | undefined;
}

export interface WaitResult {
  readonly key: IndexKey;
  readonly elapsedMs: number;
  readonly note: string | undefined;
}

/**
 * Poll until the index is genuinely serving the definition we pushed.
 *
 * Three outcomes, kept distinct because conflating them causes bad rollbacks:
 * ready (returns), failed (throws IndexBuildFailedError — the definition is
 * bad), timed out (throws ReadinessTimeoutError — the apply worked and Atlas is
 * still building).
 */
export async function waitForReady(
  gateway: SearchIndexGateway,
  key: IndexKey,
  options: WaitOptions,
  clock: Clock,
  reporter: ProgressReporter,
): Promise<WaitResult> {
  const startedAt = clock.now();
  const id = keyToString(key);
  let lastState = '';

  for (;;) {
    const index = await gateway.get(key);
    const elapsedMs = clock.now() - startedAt;

    if (!index) {
      throw new IndexBuildFailedError(id, ['index disappeared from Atlas while waiting for it']);
    }

    const readiness = assess(index, options.targetVersion);
    const state = readiness.state === 'ready' ? index.status : `${index.status}`;
    if (state !== lastState) {
      lastState = state;
      reporter.indexStateChanged({
        cluster: gateway.cluster,
        index: id,
        state,
        detail: readiness.state === 'ready' ? readiness.note : describe(readiness),
        elapsedMs,
      });
    }

    if (readiness.state === 'ready') return { key, elapsedMs, note: readiness.note };
    if (readiness.state === 'failed') throw new IndexBuildFailedError(id, [readiness.detail]);
    if (readiness.state === 'gone') {
      throw new IndexBuildFailedError(id, ['Atlas reports the index does not exist']);
    }

    if (elapsedMs >= options.timeoutMs) {
      throw new ReadinessTimeoutError(id, elapsedMs, `${index.status} — ${readiness.detail}`);
    }
    await clock.sleep(options.pollIntervalMs);
  }
}

/** Wait for an index to be gone, which is the readiness question for a delete. */
export async function waitForDeleted(
  gateway: SearchIndexGateway,
  key: IndexKey,
  options: Pick<WaitOptions, 'timeoutMs' | 'pollIntervalMs'>,
  clock: Clock,
): Promise<void> {
  const startedAt = clock.now();
  for (;;) {
    const index = await gateway.get(key);
    if (!index || index.status === 'DOES_NOT_EXIST') return;
    const elapsedMs = clock.now() - startedAt;
    if (elapsedMs >= options.timeoutMs) {
      throw new ReadinessTimeoutError(keyToString(key), elapsedMs, index.status);
    }
    await clock.sleep(options.pollIntervalMs);
  }
}

function describe(readiness: ReturnType<typeof assess>): string | undefined {
  return 'detail' in readiness ? readiness.detail : undefined;
}
