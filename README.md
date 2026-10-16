# searchdex

Atlas Search index definitions as JSON in your repo. One command to see the diff,
apply it, and wait until queries are actually live again.

> Terraform can manage Atlas Search indexes if your whole Atlas project already
> lives in Terraform. If it doesn't, searchdex gives you the same thing with JSON
> files and one command — and it waits until your queries actually work again.

Being straight about Terraform matters, so here is the honest comparison rather
than a claim of novelty. `mongodbatlas_search_index` is a real resource and it
does have a `wait_for_index_build_completion` flag. But that flag is **off by
default**, and when you turn it on it waits for `status` to reach `READY`. On an
update, Atlas keeps serving the *previous* definition while the new one builds,
reporting `READY` and `queryable: true` the entire time — so a status-only wait
returns before your change is in effect.

searchdex waits until every host is serving the definition you just pushed. That
difference is the reason it exists. The evidence is in
[VERIFICATION.md](./VERIFICATION.md).

---

## Install

```bash
npm install -D searchdex
```

Node 20+. Credentials come from the environment, never from a flag:

```bash
export ATLAS_PUBLIC_KEY=...
export ATLAS_PRIVATE_KEY=...
```

The key needs **Project Search Index Editor** to apply, **Project Read Only** to
diff.

## Layout

```
search-indexes/
  <database>.<collection>.<indexName>.json
```

The filename is the index identity, so you can tell what a file is without
opening it, and `git log` on one path is the history of one index. The file
contains the `definition` payload and nothing else:

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "title": { "type": "string", "analyzer": "lucene.english" }
    }
  }
}
```

## Commands

```
searchdex pull      write deployed definitions into the repo
searchdex diff      what's deployed vs what's in ./search-indexes/
searchdex apply     converge, then wait until queryable
searchdex drift     exit non-zero if deployed ≠ repo  (for CI)
```

### Start with `pull`

Nobody starts with definitions in git; they start with indexes somebody created
in the UI. `pull` is the on-ramp:

```bash
searchdex pull --cluster acme-prod --project-id 5f1a...
```

It writes the *canonicalised* definition, so the very next `diff` reports no
changes. A pull that immediately shows drift would be a bug.

### `diff`

```
$ searchdex diff

  cluster: acme-prod
    ~ jobs.job_search        mappings.fields.title.analyzer
                                 deployed  lucene.standard
                                 local     lucene.english
    + jobs.mentor_search     new index
    - jobs.legacy_search     exists remotely, not in repo

  3 changes on acme-prod.  Run `searchdex apply` to converge.
```

### `apply`

Shows the diff, asks, then converges and waits:

```
$ searchdex apply --cluster acme-prod

  jobs.job.job_search  BUILDING (4s) — 1 of 3 hosts still serving an older definition
  jobs.job.job_search  READY (31s)

  cluster: acme-prod
    ~ jobs.job.job_search    live after 31.2s
```

`--yes` skips the prompt. Without a tty and without `--yes` it refuses rather
than assuming yes.

### `drift` in CI

```yaml
- run: npx searchdex drift
  env:
    ATLAS_PUBLIC_KEY: ${{ secrets.ATLAS_PUBLIC_KEY }}
    ATLAS_PRIVATE_KEY: ${{ secrets.ATLAS_PRIVATE_KEY }}
```

Exit codes: `0` no changes · `1` changes pending · `2` error. The middle one is
the point — a non-zero exit that is not a failure. `apply` also exits `1` when
the confirmation is declined or there is no tty to ask, so a pipeline missing
`--yes` fails rather than reporting a deploy that never happened.

## Several clusters

No config file is needed for one cluster. For more, `searchdex.config.json`:

```json
{
  "projectId": "5f1a...",
  "clusters": ["acme-prod-eu", "acme-prod-us", "acme-prod-ap"],
  "concurrency": 3
}
```

A `.ts`, `.js` or `.mjs` config can compute the list instead of hard-coding it.
Clusters run three at a time by default, each cluster's changes in sequence. If
one fails, the rest continue (or `--fail-fast` stops scheduling), and the run
prints a resume hint:

```
  Re-run with --run-id 9f2c... to resume from the clusters that succeeded.
```

Completed clusters are recorded as they finish, so a resumed run does not redo
work. That file records only "cluster X completed during run Y" — never what is
deployed. Atlas is the only source of truth for that; there is no state file to
drift, reconcile, or lock.

## Safety

- `diff` and `drift` are read-only and are the default posture.
- `apply` shows the plan and requires confirmation unless `--yes`.
- **Deletes require `--allow-delete`.** An index missing from the repo is far
  more likely to be an incomplete repo than an intended deletion.
- The API key pair is never logged, never accepted as a flag, and never appears
  in a request beyond the digest hash.
- On any 4xx, Atlas' own error text is printed verbatim, not paraphrased.

## Why the diff does not cry wolf

Atlas never returns the definition you sent — it adds the fields it owns and
fills in every default you omitted. A naive comparison reports drift constantly,
which is how a drift checker gets muted and then ignored. searchdex normalises
both sides first:

- server-owned fields (`indexID`, `status`, `queryable`, …) are dropped
- fields equal to their documented default are dropped, keyed on the `type`
  discriminator so it works at any nesting depth
- object key order and whitespace are not changes; **array order is**, because
  Lucene cares about analyzer and token-filter order

The defaults table is generated from MongoDB's own
`@mongodb-js/search-index-schema`, and a test regenerates it on every run and
fails if the published schema has moved.

Where normalisation cannot explain a difference — a field present on one side
only, with no documented default — it is reported as *unexplained* rather than as
confident drift, with a note saying so. Claiming certainty we do not have is the
other way to lose the reader's trust.

## Not in scope

Anything besides search indexes. Cluster provisioning, users, network config —
that is Terraform's job, and it is good at it. No query building, no runtime, no
UI. Vector Search definitions are read and preserved by `pull
--include-vector-search` but not applied in v0; the resource shape differs enough
to deserve its own pass.

searchdex does not touch Mongoose or the MongoDB driver. It talks to the Atlas
Admin API over HTTPS, so it is ODM-agnostic and driver-agnostic by construction
and no version matrix applies. Keeping it that way is deliberate.

## Architecture

```
src/
  domain/          index model, normalisation, diff, readiness policy — pure
  application/     use cases over ports: plan, apply, pull, wait, fan-out
  infrastructure/  Atlas HTTP + digest, filesystem, schema validation, config
  presentation/    CLI, commands, human and JSON rendering, exit codes
```

Dependencies point inward. The domain knows nothing about HTTP or disk; the use
cases depend on the interfaces in `application/ports.ts` and never on a concrete
adapter; `presentation/context.ts` is the only file that decides which adapter
backs which port.

That is not decoration. Because `SearchIndexGateway` is a port, the whole apply
path can be driven against an in-memory Atlas in unit tests, against a local HTTP
server speaking the real wire format in integration tests, and against a real
`mongot` in `@mongodb-js/atlas-local` — through a driver-backed adapter that
exists only in the test tree — for the acceptance test.

## Tests

```bash
npm test            # 191 tests: unit, integration, stress. No network, no docker.
npm run test:coverage
npm run test:e2e    # real local Atlas in docker, real $search query
```

`test/stress/` is where the awkward cases live: generated definitions checked
against normalisation's invariants, a server that hangs or returns an HTML error
page from a proxy, index names needing percent-encoding, 500 indexes on one
cluster and 40 clusters in a fan-out, and every command's failure path.

The e2e suite is the one that proves the flagship claim: it applies a change and
then runs an actual `$search` query with no retry loop. A retry would hide
exactly the bug the test exists to catch.

## Licence

MIT
