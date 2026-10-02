# UI02 #740 React foundation evidence

Validated on 2 October 2026 in the isolated `cb/issue-740-react-foundation`
checkout, based on `1a643463769b2c87f1503b22f9fb14068160d846`.
The frozen candidate SHA is supplied in the implementation handoff; this
document belongs to that candidate. The approved six-slice plan is
[issue #740's implementation plan](https://github.com/chrisbanes/ensemble/issues/740#issuecomment-5942929265)
with semantic digest `sha256:ef6d6409a4a43ce786f2c8a1e9308d181fe57a630e5456a685820ee2f692ac4b`.

## Delivered boundary

One production operator listener mounts the built React `/app` shell,
same-origin validated JSON, and retained forms. Authentication continues to use
the existing sessions, exact Host/Origin/CSRF checks, expiry and cookie policy.
Strict curated DTOs exclude credentials, captured instructions, workspace paths
and raw diagnostic/process payloads. Existing domain and coordination commands
remain the policy and durability authority. Receipts describe the original
recorded outcome, including replay after later changes and service reopen.

Active execution keeps its admitted generation across instruction apply.
Unresolved results expose the exact public revision and permitted same-task
recipient. Complete operational screens belong to the named children in the
[retained-control inventory](../design/ui02-foundation.md); their legacy routes
remain reachable.

## Validation

Node `24.21.0`, npm `12.2.0`, TypeScript `7.0.2`, Zod `4.6.5`, React/React DOM
`19.3.0`, Vite `8.3.2`, Radix Dialog `1.1.23`, Playwright `1.63.0` and cached
Chromium `153.0.8010.12` (revision 1243) were used. All three local font packages
are pinned to `5.3.0`; runtime fonts use emitted same-origin WOFF2 assets.
No browser installation was needed. CI installs the same pinned npm and runs
the same check.

Pinned commands used this PATH, including a temporary npm wrapper so nested
package scripts also invoke npm 12.2.0:

```sh
export PATH=/private/tmp/ensemble-ui02-npm-bin:/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin:$PATH
npm ci
npm run build
node --test dist/test/operator-api.test.js dist/test/operator-contracts.test.js dist/test/operator-client.test.js dist/test/operator-control-inventory.test.js dist/test/operator-web-http.test.js dist/test/operator-web-integration.test.js dist/test/operator-web-browser.test.js
npm run check
git diff --check
```

The scoped suite passed **27/27**. The final full check passed **341/341**, with
zero failures, cancellations or skips, strict server/browser type checks,
formatting, build and lint. Its log is retained at
`/private/tmp/ensemble-ui02-final-check.log`. Four existing lint warnings remain
in unchanged core/state/S05 test code. Vite reports dependency `use client`
directive warnings; actual browser tests passed. npm ci blocked the optional
fsevents install script without preventing the build. An intermediate final
check stopped on one formatting diagnostic, corrected before the passing run.

Tests exercise real temporary SQLite and the existing command/view seams with
a deterministic fake runtime. Coverage includes original receipt replay,
post-commit wakeup rejection and reconciliation, paused task admission,
dependency scope/cycle/revision failures, active old-generation execution,
held-request precedence and unconfirmed writer/capacity uncertainty, retained
history omissions, imported source sync observations, secret/path exclusions,
exact-material approval and denial policy, result-recipient replay/stale/foreign
and unavailable outcomes, and service reopen.

The executable inventory renders real current forms, including conditional
GitHub/source, recovery, question, approval and result controls, and compares
their actions, fields and destinations to the checked-in owner inventory. It
observed **38 forms, 12 command discriminants, 12 form actions and 16 registered
Runtime/Coordination routes**. This proves retention, not replacement-screen
acceptance.

Chromium exercised JSON login and rotation, incorrect login, successful logout,
honest lost-logout reconciliation, idle/absolute expiry and restart, rejecting
private reads/writes with exact 401/403 and zero unauthorized mutations. HTTP
cases include Host/forwarded spoof, missing/null/foreign Origin, wrong CSRF,
malformed UTF-8/JSON, oversized bodies, wrong media, unsupported/unsafe asset
paths and symlinks, and HTTPS Secure host-only cookies. Client tests preserve
entered input/key after 409 or lost writes without automatic retry, abort old
reads, clear private data on expiry and retain stale data only within the same
resource identity.

Browser repair findings were reproduced before correction: native fetch needed
an unbound receiver, login 401 needed to preserve the visible failure, and a
successful `/login` needed to replace its route with `/app`. Browser cases then
passed at 1366×820, 390×844 and 683×410 with deviceScaleFactor 2. The latter
represents a 1366px physical desktop at 200% layout scale; it is not evidence
of changing Chromium's native zoom setting. Tests verify semantic names/roles,
computed typography, primary/supporting/badge contrast, visible keyboard focus,
Tab/Shift+Tab, phone drawer containment/Escape/focus restoration/navigation,
reachable unoccluded actions, literal malicious text, loading/empty/populated/
stale states, deep reload and no horizontal overflow. There were **zero external
browser requests, CSP violations or page errors**. This is bounded accessibility
evidence, not a certification.

## Technical seam adjustment

One factual mismatch was diagnosed: the existing approval command requires
exact retained material for denial when immutable material exists, whereas the
public unsafe-material DTO deliberately omits it. The lead approved a bounded
adapter repair, with core unchanged: an omitted-material denial privately
reconstructs only the exact same-task interaction's retained JSON and preserves
the submitted revision/action/target. Supplied material is never replaced;
approval cannot bypass the exposed exact-byte requirement. Reconstruction is
independent of current privacy redaction so saved-key replay survives a privacy
change. Legacy null material stays omitted, and unsafe action/target remains
unavailable. The first edit/validation cycle passed; diagnosis 1 and repair
cycle 1 were used, with no second cycle. Meaningful tests prove unsafe public-read
denial, exact replay/reopen/privacy change, altered action/target/material and
fresh-key stale rejection, and no secret DTO/receipt exposure.

## Screenshots and cleanup

The passing full check retained screenshots outside fixture directories at
`/private/tmp/ensemble-ui02-evidence-7474`. For each of `1366`, `390` and `683`,
files are `-signin.png`, `-loading.png`, `-empty.png`, `-populated.png` and
`-stale.png`; `1366-zoom200.png` records the 683px layout at scale 2. They belong
to the validated source candidate. The deliberate script-like project name is
literal text and did not execute.

Every fixture awaits listener shutdown, auth disposal, fake-runtime/service
shutdown and removal of its temporary database/workspaces. Every browser test
awaits browser/context closure. An additional teardown probe confirmed deleted
directory `/private/var/folders/k6/qdrr06ls5zv2cp7076j6qnmw0000gn/T/ensemble-ui02-Bb96LR`
with ENOENT, connection refusal from `http://127.0.0.1:57039`, disconnected
Chromium, and zero fake turns. Screenshot/log directories intentionally remain.

No real Codex/model turn, production listener, deployment, native UI01 claim,
paused X work or cutover occurred. The previous native-question **UI02 runtime
acceptance scenario** remains unproved. UI01/UI03–UI07 and parent #736 final
product acceptance remain separate; this evidence qualifies only #740's
foundation integration.
