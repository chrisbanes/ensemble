# Shared UI command lifecycle evidence

Task creation and private configuration now use `CommandLifecycle` for three operations: keeping an immutable validated submission, admitting one deliberate send, and settling its outcome. `OperatorClient` continues to validate transport responses. Consumer receipt predicates, fields, notices, revisions and persistence remain local. A later 400/403/409 cannot unlock an already uncertain operation; only a matching original receipt can confirm it.

## Qualified candidate

This work implements [#756](https://github.com/chrisbanes/ensemble/issues/756) against `e544bcb8f7b9a6dc8b716d429937f4017fa3a444`, under the [reviewed revision 1 plan](https://github.com/chrisbanes/ensemble/issues/756#issuecomment-5955391149). Its exact published body SHA-256 is `554f412accde3b402b227d7086596c841f1c498517e75049248e34b9eaa18d94`. The tested implementation and test-file manifest has SHA-256 `9fa83f2e14c7ec256720c7a7fa656064c245d9d8c8f681bf83e32d208a95a9e2` (sorted path-to-file-SHA JSON, excluding documentation). The final owner packet binds the patch, individual files, logs and PNGs. Documentation added after execution does not constitute another runtime qualification.

The pinned environment is Node `v24.21.0`, npm `12.2.0`, Playwright `1.63.0` and Chromium `153.0.8010.12`. Tests use the production Vite bundle, same-origin authenticated service, disposable real SQLite and deterministic runtime/provider data. The new journeys issue no external provider request or real model turn. Existing deterministic admission tests continue to exercise their fixture runtime.

## Shared and local responsibilities

| Boundary | Responsibility |
| --- | --- |
| `CommandLifecycle` | Clone the original validated command and receipt; preserve serialized bytes and omissions; block duplicate sends, replacement while uncertain and ordinary replacement after confirmation; keep uncertainty during pending reconciliation; require original key plus the consumer predicate. No fetch, storage, timer, auth policy or form model. |
| Composer | Validate and create task/assignment IDs once; correlate domain kind, task/project/open/ready/final version; verify the existing version-1 same-tab storage record before every POST; preserve 262,144-byte recovery and 65,536-byte command bounds. A detached mount cannot remove the recovery now owned by a replacement, publish a receipt or call `onRecorded`. |
| Configuration | Keep values and frozen private commands in authenticated memory; correlate command/resource/revision, preview selection/config version, capacity global/overrides and exact placement destination. Explicit revision adoption retains input with a new identity after a definite conflict. Purge invalidates late completion without browser persistence. |
| Client and App | Capture request authentication generation; invalidate synchronously on logout/expiry/different accepted session; preserve identical authenticated observations. An old 401 cannot purge a newer session. Current 401 still purges; bootstrap success/error and logout finalisation also respect their captured scope. |

## Executed evidence

The first shared-boundary test failed because the boundary was absent, then passed with snapshot/admission/uncertainty settlement. The auth-scope and composer-disposal tests initially failed on missing public methods before implementation. The configuration snapshot test produced a behavioural red: mutating an exposed frozen placement view changed its displayed owner/destination. The extraction makes those views copies. A final self-review red also showed that a supplied receipt predicate could mutate the private command; predicates now receive a command copy, preserving later reconciliation identity. Existing green tests and expanded receipt/status tables are retained characterisation and regression evidence, not artificial reds.

- State/client tests cover exact immutable bytes, task/configuration identity mismatches, restored uncertainty, reset, sticky later failures, blocked edits/adoption/new operations, delayed private purge, composer replacement before old receipt release and effect reactivation. Strict schemas reject inactive preview and invalid capacity resource shapes before receipt matching; schema-valid wrong selection/config version/global/override results remain unknown through the consumer predicates.
- Real SQLite creation and configuration consumer/API proofs inject typed post-commit notification failures only into their fixture-owned domain command. Each failure becomes unknown after one mutation. Original-key replay returns the original receipt with no extra task/version; changed payload under that key conflicts. Existing lost-response/restart, policy and domain/API proofs remain in the integration set.
- Production composer tests retain storage failure with zero POSTs, exact lost-response replay and later 400/403/409. A held committed response is released only after SPA navigation mounts a replacement composer. A second journey expires the session, signs in through the existing Login form in the same document, mounts the replacement, then releases an old held 401. Both preserve exact recovery bytes and replay once to one task/assignment, with no automatic send or stale callback effects.
- Production placement uses three different real fixture memberships: owner A, initiating project B and chosen destination C. Loss, conflict-row removal, navigation, reload, later 400/403/409 and a schema-valid receipt naming B cannot alter the original A/C command. Exact reconciliation returns the original C receipt, still reachable in B, after one version increment.
- Production private configuration holds a committed response across expiry or logout. Reauthentication and new private input precede old receipt/401 delivery. Old input, notices and receipts cannot repopulate the new session. Current expiry still purges the new input. Curated GET/receipt/error bodies, URL and local/session storage exclude the synthetic private inputs; no private draft is reconciled across sessions.
- The current logout-401 journey also proves Sign out is usable after reauthentication. Logout disposes and aborts an old held configuration GET (`ERR_ABORTED`); its intercepted 401 cannot be delivered to the client. The initial browser assertion expecting that response timed out. One focused factual-seam diagnosis and one mechanical assertion repair were used. Delivered old-read 401 suppression is proved at the controlled `OperatorClient` seam; the production GET case proves abort isolation. No test-only browser control was introduced.

The App shows Loading until bootstrap finishes, so a held bootstrap followed by Login is not a reachable production UI journey. Controlled captured-scope session success/error tests and inspected App wiring cover that guard; this evidence does not claim a production bootstrap race. Effect reactivation is covered at the composer state seam; the application currently renders without StrictMode.

## Checks and entry points

Pinned `npm ci` completed with 60 packages. Final `npm run build` passed, followed by:

| Validation | Result | Log |
| --- | --- | --- |
| Shared/client/composer/configuration state suites | 33/33 | `/tmp/ensemble-756-final-focused.log` |
| T4 domain/API/configuration/composer, production browsers, inventory, integration and HTTP security | 92/92 | `/tmp/ensemble-756-t4-tests.log` |
| `npm run check` (typecheck, lint, formatting, service/web builds and all tests) | 502/502; zero failures, cancellations, skips or todos; 30,754.517292 ms | `/tmp/ensemble-756-check.log` |
| `git diff --check` | Passed | Owner packet |

Every command used `PATH=/tmp/ensemble-ui02-npm-bin:/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin:$PATH`. Sandbox test attempts reached localhost `EPERM`; the exact failed commands were rerun with authorised localhost access. Full-check and T4 sandbox diagnostics remain in `/tmp/ensemble-756-check-sandbox-denial.log` and `/tmp/ensemble-756-t4-sandbox-denial.log`. The initial held-GET assertion is retained as a captured excerpt at `/tmp/ensemble-756-held-get-original-failure.txt`; its earlier full redirected log was overwritten by the exact rerun. No teardown/assertion failure is masked. Existing nonfatal Biome and Radix warnings remain.

The exact T4 command was:

```sh
node --test dist/test/operator-task-browser.test.js dist/test/operator-settings-browser.test.js dist/test/operator-task-composer.test.js dist/test/operator-configuration.test.js dist/test/domain.test.js dist/test/operator-api.test.js dist/test/operator-control-inventory.test.js dist/test/operator-web-integration.test.js dist/test/operator-web-http.test.js dist/test/operator-web-browser.test.js
```

Both the T4 run and final full check produced separate PNG evidence. Laptop viewport is 1366×820, phone 390×844; retained scaled journeys also run at 683 CSS pixels. Full-page PNG heights can exceed the viewport. `/tmp/ensemble-756-screenshots.json` records each actual dimension, file size and SHA-256. Visual self-review found the selected uncertainty/reconciliation/privacy states and their controls readable.

| Final run directory | PNGs |
| --- | --- |
| `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-ui02-evidence-18648` | 16 |
| `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-ui02-evidence-23044` | 16 |
| `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-ui03-evidence-18646` | 69 |
| `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-ui03-evidence-22984` | 69 |
| `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-ui06-evidence-18645` | 36 |
| `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-ui06-evidence-22980` | 36 |

After the final check, only this evidence document's results metadata changed. Focused document/diff checks cover that update; the tested code/test manifest remains unchanged. Independent review, publication and final acceptance remain pending.

The affected React entry points are global/project New task and `/app/tasks/new?project=<id>` restoration; Settings setup, profile, project, routing, source and placement; and Runtime capacity. Both local consumers are exercised through these existing routes. Inventory, retained web integration and browser/security tests retain `/`, `/project/:id`, `/profile/:id`, `/task/:id`, Runtime and Coordination editors. Their server-owned forms do not use the new lifecycle. No additional context menu, extension, deep link or notification owns either affected command lifecycle.

The retained inventory measures 84 individual controls and 15 concrete reachable destinations, alongside 42 rendered forms, 13 command discriminants, 14 form actions and 18 extension routes. Reverse paths remain deliberate reconciliation, editable correction after first definite failure, explicit revision adoption, composer discard while editable and authenticated-session purge. Disposal/abort do not cancel a committed operation.

This evidence does not qualify a real runtime/provider integration, independent execution sandbox, native Codex/ChatGPT visibility, deployment, release or cutover. Existing qualification gates and recovery holds remain unchanged.
