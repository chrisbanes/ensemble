# S03a workspace and writer evidence — 29 September 2026

Tested runtime source: `2d9f51d8bfce976872214da1b57090c5bbc67b0b` on `cb/690-workspaces`. This merge joins the previously reviewed CB-37 head `becf0dc3f3f2b6bdaae5dcb6816bc632b9460c8b` (original base `8eae34c6366358492ec093dbfb6035d192962c11`) with merged `main` `cce19a5952e0be56480db02b05ecb9cff8ea0ddf`. The effective `main..source` change is confined to the README, this report, standalone Codex/index/service/state/workspaces, and Codex runtime/task writer/workspace tests. The merged main domain and operator blobs are retained exactly, including the #713 retry-key and task-scope repairs. The merge also retains #712 runtime safety and #705 changes. CB-52's overlapping branch was not merged separately; its first-start recovery behavior is present in the included lineage and verified below.

Toolchain: macOS arm64, Node `24.21.0` (the version in `.node-version`), npm `12.1.0`, Apple Git `2.54.0`. `package-lock.json` SHA-256: `f0777e9167630517487b4dd3bae538ea8188228928623de19c17fa61e8a0d8cc`.

| Check on tested source | Result |
| --- | --- |
| Focused `node --test dist/test/{codex-runtime,standalone,task-writer,workspaces,domain,operator}.test.js` | 49/49 pass |
| Pinned `npm ci --no-audit --no-fund` | Pass |
| `npm run check` (typecheck, lint, format, build, tests) | 69/69 pass |
| `git diff --check` | Pass |

The focused cases use real SQLite, Git and filesystem fixtures for task binding, repository-free and multiple-repository workspaces, interrupted provisioning, first-start recovery, retention, cleanup and missing paths. Deterministic runtime cases cover one qualified successor, waiting and early-result behavior, restart/crash, Stop, failure, missing/conflicting terminal reports, unfinished callbacks, known survivors, conversation replacement and stale-result rejection. The initialization fixture closes OS stdin before replying, then verifies prompt EPIPE or stop behavior; separate cases retain `turn/start` and approval-denial EPIPE coverage. The upstream stopped-child restart case also passes.

The normal handoff rule trusts a bound successful terminal report after Ensemble callbacks end and no other hold or known unfinished execution remains. Diagnostic tool-history completeness is not a release condition. An untracked detached child may overlap a successor after qualified success; this evidence does not establish physical containment or authorize force unlock. Scheduler, cancellation, capacity and inbox delivery integration belong to #691. This is local S03a evidence for the merged source, not a completed release gate or a claim that draft PR #714 has been updated or checked at this head.
