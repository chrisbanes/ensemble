# Issue #788: bounded workspace Git evidence

The workspace service now gives Git calls finite operation deadlines, cancels its directly owned child during shutdown, and persists a held binding when a timeout, cancellation, output overflow, or unobserved child exit leaves filesystem effects uncertain.

## Runtime limits

Production defaults are 30 seconds for repository identity, ref resolution, and checkout `rev-parse`; 120 seconds for Git status and worktree add/remove; a 2-second SIGTERM grace; and a further 2-second observation window after SIGKILL. Captured stdout and stderr share the existing 1 MiB cap. Tests shorten these values without changing public service configuration.

Each failure stores a fixed operation code and kind. It omits command arguments, working paths, Git output, repository identifiers, and operating-system error text. Older workspace rows migrate with `gitUncertain = false`. An uncertain operation sets the binding to `held`; recovery leaves that marker and the existing workspace path intact instead of retrying provisioning.

## Real-Git service run

On 7 October 2026, a fresh two-repository `StandaloneService` fixture run after the fixture identity repair used source commit `24168ed399514b538bebc1e9b3471f09d1abac62`, provisioned two local one-file repositories, looked up and revalidated the task workspace, then archived both clean worktrees. Node was v24.21.0, npm was 12.2.0, and Git was 2.54.0 (Apple Git-157). The controlled test wrapper delegated ordinary commands to `/usr/bin/git` and measured each delegated invocation. This is a local fixture envelope, not a production latency profile. The complete output is `/private/tmp/ensemble-788-reviewfix-two-repository-git-timing.log`.

| Operation | Calls | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Repository identity | 36 | 20 ms | 24 ms | 31 ms |
| Ref resolution | 2 | 27 ms | 29.5 ms | 32 ms |
| Checkout validation | 4 | 23 ms | 26 ms | 30 ms |
| Worktree add | 2 | 35 ms | 35.5 ms | 36 ms |
| Archive status | 2 | 25 ms | 25.5 ms | 26 ms |
| Worktree remove | 2 | 34 ms | 34.5 ms | 35 ms |

## Bounded interruption checks

The workspace tests use a controlled executable, real SQLite, and real repositories. One test lets Git create a worktree, then stalls the wrapper while a descendant keeps stdout and stderr open. With a 1-second test deadline, 20 ms TERM grace, and 40 ms observation window, the helper settled about 1,001 ms after the wrapper entered its stall. The owned Git child exited on SIGKILL; the descendant was still alive at settlement. The binding was held with `gitUncertain = true`, the created worktree path remained, and reopen/recovery launched no replacement Git process. Fixture cleanup then verified the descendant’s unique fixture path/token and normalized process birth identity before each signal, stopped that exact descendant within its watchdog, and confirmed it was gone. A separate stale-event regression kept an unrelated live child alive when its PID appeared with a stale birth identity.

Additional controlled cases exercised ready-workspace validation, archive status, worktree removal, cancellation, and output overflow. They verified bounded settlement, safe failure text, durable uncertainty, preservation of the workspace path, and that an archive-status failure does not proceed to worktree removal. The SQLite migration test verified that an older row reads as certain until a new uncertain outcome is observed.

Through the production service, stop during direct provisioning, archive status, and worktree removal settled 75 ms, 67 ms, and 72 ms after the controlled child became ready. Each direct child exited on SIGKILL while SQLite remained open; provisioning retained its uncertain binding, archive status did not proceed to removal, removal retained the workspace path, and the archive hold remained after reopening SQLite. Each scenario launched Git once. A separate stalled workspace-recovery stop settled 68 ms after child readiness with the database open at child exit, the uncertain binding and workspace path retained, no Git retry, no runtime factory or start call, and no thread or turn admission. The service-start catch reported `Error: database is not open` in this cancellation race; the contract is an aborted, rejected start with bounded settlement and preserved held state, not a stable error-message guarantee.

A deterministic return-barrier test covers cancellation after production `recover()` returns but before startup continues. It holds service stop before SQLite close, cancels the same `WorkspaceManager`, then releases recovery. The sticky cancellation check rejects startup with `WorkspaceManagerCancelledError` before runtime construction, with zero thread or turn admission. Removing only this guard reproduced the counterexample on the same barrier: startup fulfilled and called the runtime factory and `runtime.start()` after stop had snapshotted no runtime. The guard was restored before the final checks. Legacy interrupted archival state without the uncertainty marker still converts to `held` and clears its ordinary transient archive hold.

## Limits

The implementation signals and observes the exact child it spawned. A direct-child exit does not prove that descendants stopped or that all filesystem effects ended. The inherited-pipe test deliberately leaves a descendant alive when the helper settles; fixture cleanup signals only when exact fixture identity still matches immediately before each signal, and it fails closed when identity is unavailable. The real-Git timings cover one small local service journey and do not establish performance for large repositories or other storage conditions.

No public archive-hold release or force-unlock control exists in this slice, and none was added. The tests establish retained uncertainty and admission blocking; they do not claim a general descendant-containment boundary or automatic reconciliation.

## Final validation

The final pinned full check used Node v24.21.0 and npm 12.2.0 and passed typecheck, lint, formatting, service/web builds, and 989 tests with 0 failures and 0 skips (68,271.595 ms test-runner duration). Its log is `/private/tmp/ensemble-788-reviewfix-final-check-pinned.log`. Focused service-boundary output is `/private/tmp/ensemble-788-reviewfix-task-writer.log`; process-identity cleanup output is `/private/tmp/ensemble-788-reviewfix-workspaces.log`.
