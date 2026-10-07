# Issue #788: bounded workspace Git evidence

The workspace service now gives Git calls finite operation deadlines, cancels its directly owned child during shutdown, and persists a held binding when a timeout, cancellation, output overflow, or unobserved child exit leaves filesystem effects uncertain.

## Runtime limits

Production defaults are 30 seconds for repository identity, ref resolution, and checkout `rev-parse`; 120 seconds for Git status and worktree add/remove; a 2-second SIGTERM grace; and a further 2-second observation window after SIGKILL. Captured stdout and stderr share the existing 1 MiB cap. Tests shorten these values without changing public service configuration.

Each failure stores a fixed operation code and kind. It omits command arguments, working paths, Git output, repository identifiers, and operating-system error text. Older workspace rows migrate with `gitUncertain = false`. An uncertain operation sets the binding to `held`; recovery leaves that marker and the existing workspace path intact instead of retrying provisioning.

## Real-Git service run

On 7 October 2026, a two-repository `StandaloneService` fixture based on source commit `24168ed399514b538bebc1e9b3471f09d1abac62` provisioned two local one-file repositories, looked up and revalidated the task workspace, then archived both clean worktrees. Node was v24.21.0, npm was 12.2.0, and Git was 2.54.0 (Apple Git-157). The controlled test wrapper delegated ordinary commands to `/usr/bin/git` and measured each delegated invocation. One run occurred while other focused test processes were active, so these measurements are a local fixture envelope, not a production latency profile.

| Operation | Calls | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Repository identity | 36 | 17 ms | 24 ms | 52 ms |
| Ref resolution | 2 | 20 ms | 22 ms | 24 ms |
| Checkout validation | 4 | 22 ms | 23.5 ms | 30 ms |
| Worktree add | 2 | 33 ms | 45.5 ms | 58 ms |
| Archive status | 2 | 21 ms | 22.5 ms | 24 ms |
| Worktree remove | 2 | 32 ms | 34.5 ms | 37 ms |

## Bounded interruption checks

The workspace tests use a controlled executable, real SQLite, and real repositories. One test lets Git create a worktree, then stalls the wrapper while a descendant keeps stdout and stderr open. With a 1-second test deadline, 20 ms TERM grace, and 40 ms observation window, the helper settled about 1,001 ms after the wrapper entered its stall. The owned Git child exited on SIGKILL; the descendant was still alive at settlement. The binding was held with `gitUncertain = true`, the created worktree path remained, and reopen/recovery launched no replacement Git process.

Additional controlled cases exercised ready-workspace validation, archive status, worktree removal, cancellation, and output overflow. They verified bounded settlement, safe failure text, durable uncertainty, preservation of the workspace path, and that an archive-status failure does not proceed to worktree removal. The SQLite migration test verified that an older row reads as certain until a new uncertain outcome is observed.

Through the production service, stopping during stalled ready-workspace validation cancelled Git before scheduler settlement. The stop returned 82 ms after the fixture reported its child ready; the direct child exited on SIGKILL, and reopening SQLite showed the same workspace identity and path in `held` state with `gitUncertain = 1`. A separate archive-status timeout settled 437 ms after the fixture entered its stall with a 400 ms deadline. Its temporary archival hold remained present before and after restart, and no writer admission was created. Legacy interrupted archival state without the uncertainty marker still converts to `held` and clears its ordinary transient archive hold.

## Limits

The implementation signals and observes the exact child it spawned. A direct-child exit does not prove that descendants stopped or that all filesystem effects ended. The inherited-pipe test deliberately leaves a descendant alive when the helper settles; fixture cleanup then stops that exact PID with a watchdog. The real-Git timings cover one small local service journey and do not establish performance for large repositories or other storage conditions.

No public archive-hold release or force-unlock control exists in this slice, and none was added. The tests establish retained uncertainty and admission blocking; they do not claim a general descendant-containment boundary or automatic reconciliation.
