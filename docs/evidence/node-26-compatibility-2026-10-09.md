# Node 26 compatibility qualification

**Disposition:** Node 26.9.0 passes `npm ci`, `npm run test:fixture-preflight` and `npm run check` locally, as does the Node 24.21.0 baseline. Node 24.21.0 remains the default baseline. Node 25, 27 and later majors are not qualified. This is local evidence for [#809](https://github.com/chrisbanes/ensemble/issues/809); CI run links are recorded in the pull request.

## Runtimes and candidate

| Item | Value |
| --- | --- |
| Tested candidate | `95faf64c96d0e142768ed86e897d5e1e79f34482` on `cb/issue-809-node-26`, based on `main` `1a3df3742c2d1ab070856bbb0341c3ab327b3b36`. Only this evidence file and no other change follows it. |
| Node 24 runtime | `v24.21.0` (`.node-version`) |
| Node 26 runtime | `v26.9.0` (host build under `~/.hermes/node`; `/opt/homebrew/bin/node` is 26.11.0 and was not used) |
| npm | `12.2.0` on both runtimes (`package.json#packageManager`) |
| Host | macOS arm64; Playwright Chromium and WebKit from the local cache |
| Method | Each runtime ran sequentially from a fresh local clone of the candidate with its own empty npm user config, `TMPDIR` and `ENSEMBLE_TEST_EVIDENCE_DIR`, so `npm ci` was clean and runs did not compete for the machine. |

## Results at the tested candidate

| Command | Node 24.21.0 | Node 26.9.0 |
| --- | --- | --- |
| `npm ci` | exit 0 | exit 0 |
| `npm run test:fixture-preflight` | exit 0; 3 pass, 0 fail | exit 0; 3 pass, 0 fail |
| `npm run check` | exit 0; 1209 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo | exit 0; 1209 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo |
| `node --test dist/test/node-runtime-journey.test.js` | exit 0; 1 pass | exit 0; 1 pass |
| `node --test dist/test/operations.test.js dist/test/operations-final-candidate.test.js dist/test/retained-evidence-integration.test.js` | exit 0; 10 pass | exit 0; 10 pass |

A second full `npm run check` on Node 26.9.0 at the same candidate also passed (1209 pass, 0 fail).

The Node 26.9.0 service/operator journey starts a real `StandaloneService` with real SQLite in a fresh private directory and the fake runtime, rejects an unauthenticated workspace request, logs in, loads the operator app shell, closes the fixture, then asserts that the listener refuses connections, the private data directory is gone, every cleanup step completed and the fake runtime ran no turn. Signal-driven CLI shutdown is covered by `test/background-service.test.ts`, which runs inside `check` on both runtimes. The SQLite backup, verify and restore tests pass on both runtimes, including snapshots whose manifest records either Node major.

## Failures repaired

| Failure | Cause | Repair |
| --- | --- | --- |
| On Node 26, every backup, verify and restore threw `ZodError` (8 tests in `test/operations.test.ts` plus one each in `test/operations-final-candidate.test.ts` and `test/retained-evidence-integration.test.ts`), found while planning | `snapshotManifestSchema.nodeVersion` required `/^v24\./` while `createManifest` writes `process.version` | The manifest pattern accepts Node 24 or later; earlier or malformed versions stay rejected, and the format and digests are unchanged. `test/operations.test.ts` asserts accept for `v24.21.0`, `v26.9.0`, `v100.0.0` and reject for `v23.9.0`, `v9.9.9`, `24.21.0`, `v26`. Reverting the pattern makes that test fail. |
| `hidden password reader restores and pauses after input error or close` > `close` asserted `isPaused()` on a destroyed stream | Node 26 makes `pause()` on a destroyed `PassThrough` a no-op; production already requests the pause and raw-mode restore | The test now spies on `pause()` and asserts it was requested for both endings, keeping `isPaused()` for the `error` ending. Removing the `pause()` call from `readHiddenPassword` makes the file fail. Production code is unchanged. |
| `production Files reads service PDF bytes and bounds page, canvas and cancellation behavior on phone` failed with a 15000 ms `locator.waitFor` timeout on the `literal.txt` preview in the first two full `npm run check` runs on Node 26.9.0 at `0aa874e68c39d5bceee9c5280cb7813fec4a0d03` (1208 of 1209 passed each time), but passed 3 of 3 alone on Node 26.9.0 and passed two full `check` runs on Node 24.21.0 | Test race: "Back to file list" restores focus to the previously opened entry in a later animation frame, which can fire after the test focuses the next entry and move focus back, so the next key press opens the wrong file. The full run's parallel load widens that window; it was reproducible, not a one-off | The test waits for the restored focus before focusing the next entry (two places). Production code and test deadlines are unchanged. After the change both full `check` runs on Node 26.9.0 and the Node 24.21.0 run passed. The failing-run logs from the earlier candidate were overwritten by the clean rerun, so this row records the observed outcome rather than a retained log. |

## Limits

- Only Node 24.21.0 and 26.9.0 were tested. `engines.node` is `>=24` as permissive metadata and does not qualify Node 25, 27 or later majors.
- No live model turn, real Codex runtime, production deployment or host power test was run. The journey uses the fake runtime.
- `check-node-26` is a CI job, not a required status check. The required context stays `check` (Node 24.21.0); making `check-node-26` required is a repository ruleset decision for the repository owner.
- Browser tests are timing-sensitive under load. The one reproducible Node 26 failure is recorded above; no other test needed a rerun at the tested candidate.
