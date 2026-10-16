import type { DeployedIndex, HostStatus } from './index-definition.ts';

/**
 * When is a search index change actually live?
 *
 * This is the question the whole tool exists to answer, so it is worth being
 * precise. Three signals, in increasing order of usefulness:
 *
 *   1. The API returned 200/201. Means nothing about queries — Atlas accepts the
 *      definition and builds it afterwards.
 *   2. `status === "READY"`. Better, but on an *update* Atlas keeps serving the
 *      previous definition while the new one builds, and reports the index as
 *      READY and queryable the whole time. Waiting on status alone therefore
 *      returns before your change is in effect.
 *   3. Every host is serving a definition version >= the one we just pushed.
 *      This is the signal that actually corresponds to "my new analyzer is live",
 *      and it is what `waitFor` targets when the API gives us per-host detail.
 *
 * Signal 3 is why this is not the same as `terraform apply` with
 * `wait_for_index_build_completion = true`, which targets status READY/STEADY.
 * See VERIFICATION.md §3.
 */

export type Readiness =
  | { readonly state: 'ready'; readonly note: string | undefined }
  | { readonly state: 'building'; readonly detail: string }
  | { readonly state: 'failed'; readonly detail: string }
  | { readonly state: 'gone' };

/**
 * @param target the definition version this apply pushed. Omit for a create, or
 *   when the API did not return one — readiness then falls back to status plus
 *   the top-level `queryable` flag, and says so.
 */
export function assess(index: DeployedIndex, target?: number): Readiness {
  switch (index.status) {
    case 'FAILED':
      return { state: 'failed', detail: failureDetail(index) };
    case 'DOES_NOT_EXIST':
      return { state: 'gone' };
    case 'DELETING':
      return { state: 'building', detail: 'index is being deleted' };
    case 'PENDING':
      return { state: 'building', detail: 'Atlas has not started the build yet' };
    case 'BUILDING':
      return { state: 'building', detail: 'Atlas is building the index' };
    default:
      break;
  }

  if (!index.queryable) {
    return { state: 'building', detail: `status ${index.status} but not yet queryable on all hosts` };
  }

  if (target === undefined || index.hosts.length === 0) {
    return { state: 'ready', note: noteFor(index, index.hosts.length === 0) };
  }

  const behind = index.hosts.filter((host) => isBehind(host, target));
  if (behind.length > 0) {
    return {
      state: 'building',
      detail: `${behind.length} of ${index.hosts.length} hosts still serving an older definition (${behind
        .map(describeHost)
        .join(', ')})`,
    };
  }

  return { state: 'ready', note: noteFor(index, false) };
}

/**
 * Everything we know but could not act on, said out loud.
 *
 * Both notes describe a readiness answer that is weaker than the usual one, and
 * a weaker answer the caller cannot see is indistinguishable from a confident
 * one — which is the failure this whole module exists to avoid.
 */
function noteFor(index: DeployedIndex, withoutHostDetail: boolean): string | undefined {
  const notes = [
    withoutHostDetail
      ? 'no per-host detail returned; readiness is based on status and the queryable flag'
      : undefined,
    index.status === 'UNKNOWN'
      ? 'Atlas reported a status this version does not recognise; treated as ready because the index is queryable'
      : undefined,
    staleNote(index),
  ].filter((note): note is string => note !== undefined);

  return notes.length === 0 ? undefined : notes.join('; ');
}

/**
 * A host is behind if it reports an older serving version. A host that reports
 * no version at all is treated as caught up: we cannot prove otherwise, and
 * blocking forever on missing data is worse than a slightly early return. The
 * caller surfaces this as a note rather than silently swallowing it.
 */
function isBehind(host: HostStatus, target: number): boolean {
  if (!host.queryable) return true;
  if (host.servingVersion === undefined) return false;
  return host.servingVersion < target;
}

function describeHost(host: HostStatus): string {
  const version = host.servingVersion === undefined ? 'version unknown' : `v${host.servingVersion}`;
  return `${host.hostname} ${host.status} ${version}`;
}

function staleNote(index: DeployedIndex): string | undefined {
  return index.status === 'STALE'
    ? 'index is STALE: queryable, but no longer replicating from the collection'
    : undefined;
}

function failureDetail(index: DeployedIndex): string {
  const failed = index.hosts.filter((host) => host.status === 'FAILED').map((host) => host.hostname);
  return failed.length > 0 ? `failed on ${failed.join(', ')}` : 'Atlas reported FAILED';
}
