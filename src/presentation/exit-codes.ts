/**
 * `0` success or no changes · `1` changes pending · `2` error.
 *
 * The middle one is the whole point of `drift` in CI: a non-zero exit that is
 * not a failure. Keeping it distinct from `2` lets a pipeline tell "the repo and
 * the cluster disagree" apart from "we could not reach Atlas".
 */
export const EXIT = { OK: 0, CHANGES: 1, ERROR: 2 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
