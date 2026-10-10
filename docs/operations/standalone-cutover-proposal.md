# Haze standalone cutover proposal

This is an executable proposal, not approval to execute it. [#761](https://github.com/chrisbanes/ensemble/issues/761) owns deployment and cutover. Nothing in this proposal authorizes touching the prototype database, enabling a competing scheduler, or resuming old work. Physical sleep/wake evidence [#732](https://github.com/chrisbanes/ensemble/issues/732) remains required before operational use.

## Named target and approval packet

The proposed target is GitHub repository `chrisbanes/haze` (`R_kgDOKlhejw`, default branch `main`), Haze Project 7 (`PVT_kwHOAAN4ns4Beqrm`, [Project](https://github.com/users/chrisbanes/projects/7)), and `Chris’s MacBook Pro`, GUI UID `501`, checkout `/Users/chris/dev/haze`. These are discovery facts, not execution approval or a selected production task.

Before executing any stage, #761 must attach a dated, reviewed packet binding every value below. An unset, ambiguous or changed value refuses the affected stage; do not substitute fixture paths or guess process identity.

| Binding | Required readback |
| --- | --- |
| Host/account | ComputerName, UID, exact GUI launchd domain; target repository and Project native IDs |
| Build | Reviewed final commit, passing final-head checks, stable absolute `NODE` (`24.21.0`), `OPERATIONS_CLI` (`dist/src/standalone/operations-cli.js`) and `SERVICE_CLI` (`dist/src/standalone/cli.js`) paths; npm `12.2.0` |
| Standalone paths | Every shell variable: `DATA`, `AUTH`, `STDOUT`, `STDERR`, `SNAPSHOT`, `RESTORE_DATA`, `LABEL`, `PLIST`, `ORIGIN`, `PORT`; separate canonical private data/auth/log/snapshot/restore paths, exact label/plist, loopback origin/free port; no symlinks or prototype overlap |
| Prototype controller | Actual controller/service/agent IDs, owning process generation and lifecycle controls, configured project/machine, all active work and writers, exact data/workspace/config paths |
| Old-work disposition | Every old task/run/execution/PR identity: finish under old owner, stop and retain recovery hold, or explicitly abandon with independent effect reconciliation; no automatic migration |
| Preservation | Exact old service/config/workspace/database preservation method, offline owner proof and verified backup identity, retention location and access controls |
| Enablement | Explicit execution approval for deployment, precise new project/source/policy setup, one named eligible task, and independently verified absence of competing owners/writers |
| Finite witness | One named small task and reviewed expected outcome, maximum concurrency 1, reviewable-PR authority with no merge, at most one submitted PR, proposed cap 3 model turns and 30 minutes; refusal if it cannot fit, changes require a reviewed packet |
| Rollback | Exact new job/data owner and stop controls; old controller restart seam and preserved configuration/data identity; approved disposition of any new effects |

Old-controller discovery must succeed before enablement. An empty `bb status` result or a failed project/machine/plugin API query (for example a connection error) is not evidence that old controllers or writers are absent, and neither is the lack of a matching filename in a LaunchAgents listing. Do not autostart a server or access the prototype database to fill the gap. **Refuse enablement until the actual old controller metadata and supported stop/readback seams are established.** Do not invent a BB command to fill this gap.

## Read-only revalidation and shell preflight

Use the existing BB CLI without autostart or database inspection:

```sh
/usr/sbin/scutil --get ComputerName
/usr/bin/id -u
bb status --json
bb project list --json
bb machine list --json
bb plugin list --json
```

Read back the actual identities and supported lifecycle controls. Unreachable, incomplete or conflicting metadata refuses enablement. A connection error is not an absence receipt. Before any later command, reject unset packet bindings in the same shell (values are supplied by the future reviewed packet):

```sh
: "${NODE:?}" "${OPERATIONS_CLI:?}" "${SERVICE_CLI:?}" "${DATA:?}" "${AUTH:?}" "${STDOUT:?}" "${STDERR:?}" "${SNAPSHOT:?}" "${RESTORE_DATA:?}" "${LABEL:?}" "${PLIST:?}" "${ORIGIN:?}" "${PORT:?}"
```

This checks presence only; canonical path, host, ownership, policy and identity validation remains required. No placeholder or syntax check qualifies a production action.

## Ordered execution and refusal gates

1. Re-read the packet bindings and native GitHub/host/controller state. Verify #732, final candidate evidence and execution approval. Keep the new project paused and tasks unready. If old work cannot be enumerated, stop here without starting or changing either controller.
2. Execute only the approved old-work dispositions through their actual lifecycle controls. Verify exact terminal generations and reconcile uncertain effects independently; an acknowledgement, missing UI row, PID alone or connection failure is insufficient. Preserve unresolved Stop, ownership, capacity and effect holds. Record each identity and receipt. Confirm no old scheduler or writer can act on Haze before enabling any new work.
3. Stop the exact old controller using the bound control seam, verify its exact process/service is absent, and preserve its database, configuration and workspaces using the approved method. Do not apply Ensemble's standalone backup CLI to a prototype database. Record backup integrity/readback and rollback controls before proceeding.
4. Build the reviewed standalone checkout with the pinned runtime and `npm ci && npm run check`. Initialize separate operator auth with the hidden prompt described in [operations](standalone-macos.md). Keep the password out of argv, plist and evidence. Render the exact reviewed plist using the absolute values from the packet:

   ```sh
   "$NODE" "$OPERATIONS_CLI" render-launch-agent "$LABEL" "$NODE" "$SERVICE_CLI" "$DATA" "$AUTH" "$ORIGIN" "$PORT" "$STDOUT" "$STDERR" "$PLIST"
   /usr/bin/plutil -lint "$PLIST"
   /usr/bin/plutil -p "$PLIST"
   ```

   All variables above are packet bindings, never defaults; `NODE`, `OPERATIONS_CLI` and `SERVICE_CLI` are stable absolute paths. Validate installed `codex`, `git`, `caffeinate` and fixed PATH resolution without altering shared configuration. The rendered plist PATH excludes `/usr/sbin`; process identity uses absolute `/usr/sbin/sysctl`. Do not claim a harmless-child proof qualifies model execution or descendant containment.
5. After approval for deployment, bootstrap the exact job and read it back:

   ```sh
   /bin/launchctl bootstrap "gui/501" "$PLIST"
   /bin/launchctl print "gui/501/$LABEL"
   ```

   Verify its exact PID/generation, private ownership lock and authenticated loopback operator UI. Fresh startup must not read the prototype database. Add/configure Haze through ordinary supported operator/domain/source controls, preserving explicit repository access and keeping the project paused. Configure and read back supported capacity limits (global and this project both one) and reviewable-PR delivery authority with merge disabled. Record native repository/Project/source identity, policy and zero admissions. A startup failure or incomplete source/provider/runtime reconciliation refuses enablement.
6. While the exact new job is stopped and absent, create and verify its standalone baseline snapshot:

   ```sh
   /bin/launchctl bootout "gui/501/$LABEL"
   /bin/launchctl print "gui/501/$LABEL" # must fail; also verify exact process exit
   "$NODE" "$OPERATIONS_CLI" backup "$DATA" "$SNAPSHOT"
   "$NODE" "$OPERATIONS_CLI" verify "$SNAPSHOT"
   ```

   Record manifest schema fingerprint, bytes/logical digest and source owner proof. Never trust an incomplete snapshot or restore. Auth, workspaces, provider state and external effects need their separately approved preservation; they are not in the database snapshot.
7. Restart the same reviewed new job, verify reconciliation and zero admissions while paused. Independently recheck old owner/writer absence. Only then explicitly enable the approved one-task production witness through ordinary project/task controls. Observe exact request/generation, result delivery, holds and external operation identities; verify no duplicate dispatch/write. Any unresolved ownership or uncertain effect freezes further admissions. The implementation agent monitors the packet's 3-turn/30-minute bounds, maximum concurrency 1 and one-PR/no-merge authority; the service is not claimed to enforce an aggregate turn/time budget. At a bound, unexpected dispatch/effect or inability to fit the task, pause/Stop and retain exact recovery holds before any further work. Success requires the reviewed expected outcome, one exact PR, valid operator settlement, successful bound terminal and Done; PR-ready alone is insufficient. This witness is not a licence to drain Haze automatically.
8. Record actual accepted completion separately from PR-ready, merged, settlement and Done. Retain exact receipts, source/runtime identities and cleanup/preservation manifests. #761 can claim cutover only after all old-work disposition, absence, backup/rollback and new-controller readbacks pass under its execution authorization.

## Failure and rollback

Before any new admission, stop and verify the exact new job, preserve its state, and leave it disabled. Do not automatically restart the old controller: first verify that the new owner/writers are absent and that old-work and effects are still safe under the approved rollback packet. Resume only the bound old controller with explicit rollback authority and read it back.

After a new admission or uncertain effect, pause/Stop through supported controls, stop the exact new job, and retain ownership/effect holds until exact-generation termination and independent provider readback establish the approved disposition. Restore never supplies such evidence or clears those holds. To exercise standalone restore, use only a verified snapshot and a distinct nonexistent private destination:

```sh
"$NODE" "$OPERATIONS_CLI" verify "$SNAPSHOT"
"$NODE" "$OPERATIONS_CLI" restore "$SNAPSHOT" "$RESTORE_DATA"
```

Require successful restore with the same manifest identity before startup; preserve an incomplete destination for diagnosis and never enable it. Render a separately reviewed destination plist. Relocated managed workspaces retain their old identity and refuse access rather than silently migrating. Provisioning/recovery and new admissions require explicit supported controls. Never run old and new jobs concurrently during rollback, and never use name-based process termination.

## Scope of the proposal

The proposal supplies ordered executable stages and refusal gates. Production paths, old-controller metadata/work disposition, a selected task, execution approval, physical #732 proof and actual cutover are unset or unproved; completing the proposal does not establish deployment or R06's actual cutover limb. #761 records those independently.
