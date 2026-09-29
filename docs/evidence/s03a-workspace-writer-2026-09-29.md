# S03a workspace and writer evidence — 29 September 2026

Tested source: `a9811810070c94d4f8edf88a59265680a367820d` on `cb/690-workspaces`, based on `8eae34c6366358492ec093dbfb6035d192962c11`. This source includes Big Head's workspace lifecycle `be946620ee0111236fd420c31dd39dff6a8d7cf9`, CB-39 through `09dc4a6b9b22c8c3811610d8f6f0797c08711eda`, the S03a writer integration `9d95b6181afaede11890b0399e07c19b8bfa2443`, and the reviewed CB-39 initialization fixture change `720e6340446586432a33385ab42d487935888d6d` reconciled as `a9811810070c94d4f8edf88a59265680a367820d`. CB-52's `0ed4aa36b8c963ca033f840dae33fb7c481bc50e` was not merged: its runtime adapter blob matches the included CB-39 source, and the service startup differences are CB-39's domain integration. The first-start recovery and ownership behavior is represented by the included source and README contract.

Toolchain: macOS arm64, Node `24.21.0` (the version in `.node-version`), npm `12.1.0`, Apple Git `2.54.0`. `package-lock.json` SHA-256: `f0777e9167630517487b4dd3bae538ea8188228928623de19c17fa61e8a0d8cc`.

| Check on tested source | Result |
| --- | --- |
| Focused `node --test dist/test/codex-runtime.test.js dist/test/standalone.test.js dist/test/task-writer.test.js dist/test/workspaces.test.js` | 35/35 pass |
| Pinned `npm ci --no-audit --no-fund` | Pass |
| `npm run check` (typecheck, lint, format, build, tests) | 66/66 pass |
| `git diff --check` | Pass |

The focused cases use real SQLite, Git and filesystem fixtures for task binding, repository-free and multiple-repository workspaces, interrupted provisioning, retention, cleanup and missing paths. Deterministic runtime cases cover one qualified successor, waiting and early-result behavior, restart/crash, Stop, failure, missing/conflicting terminal reports, unfinished callbacks, known survivors, conversation replacement and stale-result rejection. The initialization fixture closes OS stdin before replying, then verifies prompt EPIPE or stop behavior; separate cases retain `turn/start` and approval-denial EPIPE coverage. The App Server exit case remains separate.

The normal handoff rule trusts a bound successful terminal report after Ensemble callbacks end and no other hold or known unfinished execution remains. Diagnostic tool-history completeness is not a release condition. An untracked detached child may overlap a successor after qualified success; this evidence does not establish physical containment or authorize force unlock. Scheduler, cancellation, capacity and inbox delivery integration belong to #691. This is local S03a evidence, not a completed release gate or a claim about an unmerged PR.
