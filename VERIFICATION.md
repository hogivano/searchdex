# Verification

The design rested on a few claims that had to be checked before writing code
rather than assumed. This is what checking them produced, on **2026-09-09**. Each finding
names its source so it can be re-checked when Atlas changes.

---

## 1. Is `searchdex` still free on npm?

**Yes**, as of that date: `npm view searchdex` returned 404.

The two packages the design relies on are real and current:

| package | version |
| --- | --- |
| `@mongodb-js/search-index-schema` | 2.1.1 |
| `@mongodb-js/atlas-local` | 1.3.1 |

---

## 2. Does `terraform apply` already wait for readiness?

**Partly — and the part it misses is the one that matters.**

`mongodbatlas_search_index` does have a wait, so the "waits until live"
differentiator is weaker than it first looked. But it is opt-in and it targets the wrong signal:

```go
// internal/service/searchindex/resource_search_index.go
if d.Get("wait_for_index_build_completion").(bool) {
    stateConf := &retry.StateChangeConf{
        Pending: searchIndexPendingStates,
        Target:  []string{"READY", "STEADY"},
        ...
```

Three specifics:

1. **Opt-in.** `wait_for_index_build_completion` is declared `Optional` with no
   `Default`, so it is `false` unless you set it. A team that has not read the
   docs closely gets no wait at all.
2. **It waits on `status`.** The target is the status string, not the
   `queryable` flag and not the per-host definition version.
3. **That is not the same as "my change is live."** On an *update*, Atlas keeps
   serving the previous definition while the new one builds, and reports the
   index as `READY` and `queryable: true` the entire time. A status-only wait
   therefore returns before the new analyzer is in effect. This is not a
   hypothetical: the `SearchIndexResponse` schema exposes
   `statusDetail[].mainIndex.definitionVersion.version` precisely because the
   serving version and the latest version can differ.

**Conclusion: keep the feature, narrow the claim.** searchdex should not say
"Terraform does not wait." It should say Terraform waits on status, opt-in, and
searchdex waits until every host is serving the definition you just pushed. That
is what `src/domain/readiness.ts` implements and what
`test/unit/readiness.test.ts` pins.

Source: `mongodb/terraform-provider-mongodbatlas`, `master`,
`internal/service/searchindex/resource_search_index.go`, and the registry docs
for `mongodbatlas_search_index`.

---

## 3. What are the real index status values?

The design guessed `PENDING → BUILDING → READY`, with a note not to trust the guess.
The guess was right, but only for the current API version — and there is a second
enum still in circulation.

From the Atlas Admin API v2 OpenAPI spec:

**`SearchIndexResponse`** (media type `application/vnd.atlas.2024-05-30+json`)
— what searchdex uses:

```
DELETING · FAILED · STALE · PENDING · BUILDING · READY · DOES_NOT_EXIST
```

**`ClusterSearchIndex`** (the deprecated 2023-01-01 shape):

```
IN_PROGRESS · STEADY · FAILED · MIGRATING · STALE · PAUSED
```

Two consequences, both implemented:

- The Accept header is **pinned** to `2024-05-30` in
  `src/infrastructure/atlas/http.ts`. Without it Atlas serves the older shape,
  which has no `queryable`, no `statusDetail` and no `latestDefinitionVersion` —
  the three fields readiness is computed from.
- Legacy values are mapped on read rather than rejected
  (`src/infrastructure/atlas/wire.ts`), and an unrecognised value degrades to
  `UNKNOWN` instead of crashing the CLI.

The spec is also explicit that `STALE` is **queryable** ("the index is queryable
but has stopped replicating data from the indexed collection"), so searchdex
treats it as ready-with-a-warning rather than as a failure.

Source: `https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2.yaml`,
schemas `SearchIndexResponse`, `SearchHostStatusDetail`, `ClusterSearchIndex`.

---

## 4. Correction to the original test strategy

The original test plan was: *spin up local Atlas in CI*, then drive searchdex
against it.

**That does not work as written.** `@mongodb-js/atlas-local` runs `mongod` plus
`mongot` in a container. It does **not** serve the Atlas Admin API — there is no
`/api/atlas/v2/...` endpoint to point searchdex at. Locally, search indexes are
managed through the driver's `createSearchIndex` / `$listSearchIndexes`
commands, which are a different API on a different plane.

So the acceptance test needs one of:

- **a test-only driver-backed gateway** — local Atlas, real `mongot`, real
  `$search` query, exercising the actual use cases through the
  `SearchIndexGateway` port. This is what `test/e2e/` does, and it is the reason
  the gateway is a port rather than a concrete class.
- **a live Atlas project** for the HTTP path, which cannot run in a normal CI.

The wire protocol itself is covered separately by
`test/integration/atlas-client.test.ts`, against a local server that speaks the
real `SearchIndexResponse` shape and demands digest auth.

---

## 5. The bug the local-Atlas test caught

Worth recording, because it is the exact failure that would kill the
tool, and unit tests did not catch it.

`mongot` fills in **per-field** defaults, not just top-level ones. Send this:

```json
{ "mappings": { "fields": { "title": { "type": "string" } } } }
```

and `$listSearchIndexes` returns this:

```json
{ "mappings": { "fields": { "title": {
  "type": "string", "indexOptions": "offsets", "store": true, "norms": "include"
} } } }
```

The first normalisation table only knew about top-level defaults, so every
string field in a hand-written definition produced three spurious differences —
and the in-memory test double, which had the same blind spot as the code,
happily agreed that this was correct. Only the container disagreed.

Two changes came out of it:

1. `src/domain/server-defaults.ts` now keys defaults off the `type`
   discriminator, which is how the schema itself is organised. One rule covers
   `mappings.fields.<any name>` at any nesting depth, plus analyzers, tokenizers
   and token filters.
2. The table is generated from `@mongodb-js/search-index-schema` rather than
   written by hand, and `test/unit/server-defaults.test.ts` regenerates it on
   every run and fails if it has drifted from the published schema.

The general lesson, which applies to the next fake as well: a test double built
from the same understanding as the code under test cannot falsify that
understanding.

---

## 6. What the stress pass found

A second pass hammered the edges — generated input, adverse networks, awkward
names, scale, and every command path. Six real defects, all fixed:

| # | Defect | Why it mattered |
| --- | --- | --- |
| 1 | `searchdex --json diff` parsed `json="diff"` and printed help | The parser guessed greedily whether a token was a value or the next flag. Now flags are declared, and an unknown one is an error rather than a silent no-op — `--alow-delete` used to look like it worked. |
| 2 | Concurrent cluster completions lost each other in the resume file | `save([...completed, name])` across an `await` is a lost update. A resumed run would have redone finished clusters. Now the mutation happens before the await and writes are queued and atomic. |
| 3 | `apply` prompted once per cluster, concurrently, on one tty | Three interleaved questions, and an answer could land on the wrong one. Now it plans everywhere, shows everything, and asks once. |
| 4 | A declined or unattended `apply` exited `0` | A pipeline missing `--yes` would have read "did nothing" as a successful deploy. It now exits `1`. |
| 5 | A single-cluster failure exited `2` with an empty screen | Failures were only rendered in the multi-cluster summary table. |
| 6 | Five accepted flags were undocumented | A test now asserts the help text covers everything the parser accepts. |

Two more things the pass changed without a bug behind them: an unrecognised
Atlas status is now accepted as ready *with a note saying it was unrecognised*
rather than silently, and four dead exports were deleted.

Worth recording what did **not** break: digest signing over percent-encoded
paths (unicode, CJK, spaces, `&`, `?`, `+`), normalisation under 300 generated
definitions, 500 indexes on a cluster, 40 clusters in a fan-out, and 500-deep
nesting.

---

## 7. Other API facts, confirmed rather than assumed

| fact | value |
| --- | --- |
| base URL | `https://cloud.mongodb.com` |
| list | `GET /api/atlas/v2/groups/{groupId}/clusters/{clusterName}/search/indexes` |
| get | `GET .../search/indexes/{db}/{coll}/{name}` |
| create | `POST .../search/indexes` → `201` |
| update | `PATCH .../search/indexes/{db}/{coll}/{name}` → `200`, body is `{definition}` only |
| delete | `DELETE .../search/indexes/{db}/{coll}/{name}` → `204` |
| auth | HTTP Digest with the API key pair, or a service-account bearer token |
| errors | `ApiError` = `{error, errorCode, detail, reason}` |
| roles | read: Project Read Only · write: Project Search Index Editor |

The namespace (`database`, `collectionName`, `name`) travels **outside** the
`definition` on create and is absent entirely on update. That asymmetry is why
`src/infrastructure/atlas/wire.ts` exists as a separate mapping layer.
