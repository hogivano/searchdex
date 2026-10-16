export const HELP = `
searchdex — Atlas Search index definitions as JSON in your repo.

Usage
  searchdex <command> [options]

Commands
  diff      show what is deployed vs what is in ./search-indexes/
  apply     make Atlas match the repo, then wait until queries are live again
  drift     exit 1 if deployed and repo disagree (for CI)
  pull      write deployed definitions into the repo (the adoption path)

Target
  --cluster <name>          cluster to act on
  --project-id <id>         Atlas project (group) id
  --config <file>           config file (default: ./searchdex.config.{ts,js,mjs,json})
  --dir <path>              definitions directory (default: ./search-indexes)
  --base-url <url>          Atlas API base (default: https://cloud.mongodb.com)

Apply
  --yes                     skip the confirmation prompt
  --allow-delete            permit deleting indexes that are not in the repo
  --wait / --no-wait        wait until queryable (default: wait)
  --timeout <seconds>       how long to wait for readiness (default: 600)
  --poll <seconds>          readiness poll interval (default: 5)
  --concurrency <n>         clusters applied at once (default: 3)
  --fail-fast               stop scheduling clusters after the first failure
  --run-id <id>             resume a previous multi-cluster run
  --state-file <path>       resume state (default: .searchdex/run-state.json)

Pull
  --include-vector-search   also write vectorSearch definitions (unmanaged in v0)

Output
  --json                    machine-readable output on stdout
  --quiet                   no progress on stderr
  --validate / --no-validate  check definitions against the Atlas Search schema
                              before sending them (default: validate)

Credentials come from ATLAS_PUBLIC_KEY and ATLAS_PRIVATE_KEY. There is no flag
for them on purpose — a flag ends up in shell history and CI logs.

Exit codes
  0  success, or no changes
  1  changes pending: drift found a difference, or apply was not confirmed
  2  error
`.trim();
