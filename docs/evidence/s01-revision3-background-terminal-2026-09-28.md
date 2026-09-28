## S01 revision 3: experimental background-terminal Stop diagnostic

This is one bounded diagnostic of the approved revision 3 explicit-Stop contract, run from `cb/35-s01-proof` at `e5198df5da736ef3d091b0bfeb695a391ac7bdd8` (runtime base `8e3ab9387389f5040631cd06e2156186aaffbc6c`, contract `5cad6813a0dd2018057966d177c2c4d415f76677`). It is **failed evidence**, not a passed termination or safe-release gate. No product supervisor, guest, scheduler, Haze process, or existing session was used.

### Commands and candidate

- `/opt/homebrew/bin/codex --version` returned `codex-cli 0.157.1`.
- `codex app-server generate-json-schema --experimental --out .s01-schema` ran without a model call. Generated `ThreadBackgroundTerminals{List,Clean,Terminate}{Params,Response}.json` confirmed `list(threadId)`, `clean(threadId)`, and `terminate(threadId,processId)`; the disposable schema directory was removed after inspection.
- `python3 -m py_compile test/s01/background_terminal_probe.py test/s01/background_terminal_writer.py test/s01/background_terminal_oracle.py` passed.
- `python3 test/s01/background_terminal_probe.py test/s01 ../.s01-bgterminal-r3` ran one real, ephemeral Codex App Server turn in a fresh disposable directory. The client initialized with `capabilities.experimentalApi=true`, started an ephemeral workspace-write thread with approval policy `never`, and asked the real model to run only `python3 background_terminal_writer.py`.
- The probe predeclared a **3 second** observation interval; the escaped child had a **30 second** natural timeout. The parent waited for it. The child opened `effects.log`, fsynced a `ready` line, then awaited the separate oracle's release marker before writing its delayed line. The oracle was a separate process that observed PIDs and effects; no PID record from it or the fixture entered `turn/interrupt` or background-terminal cleanup. Cleanup used only the thread ID. An SQLite WAL row, with `synchronous=FULL`, committed writer and capacity holds before submission and a Stop hold before interrupt. Every replacement check throughout returned `allowed=false`.

### Observations

Wall times below are Unix seconds from the raw trace. `trace.jsonl` also records monotonic nanoseconds; the separate oracle trace samples process and effect state at approximately 100 ms intervals. The two traces are preserved as `s01-r3-background-terminal-trace-2026-09-28.jsonl` and `s01-r3-background-terminal-oracle-2026-09-28.jsonl`.

| Event | Time | Evidence |
| --- | ---: | --- |
| Writer active | 1790590239.575976 | Parent PID 60260, PPID 59976, PGID/SID 60260; child PID 60336, PPID 60260, PGID/SID 60336. Both born `Mon Sep 28 11:10:39 2026`; `ready` was fsynced at 1790590239.519122. App Server PID 59976, PGID/SID 59976. |
| Durable Stop hold | 1790590239.576718 | SQLite row `stopping, writer_hold=1, capacity_hold=1, stop_hold=1`; replacement denied. |
| `turn/interrupt` | 1790590239.576786 | Response `{}` at 1790590239.577816; `turn/completed` reported `interrupted`. |
| `backgroundTerminals/list` | 1790590239.578570 | One registered `python3 background_terminal_writer.py` item, processId `39761`, itemId `exec-47396563-0c40-4adc-acbc-33b4f032c185`, `osPid=null`. |
| `backgroundTerminals/clean` | 1790590239.578644 | Response `{}` at 1790590239.578946. Subsequent list returned empty at 1790590239.579247. |
| Oracle release | 1790590239.579282 | Sent only after cleanup acknowledgement and empty list. |
| Delayed effect | 1790590239.589637 | Child wrote and fsynced `delayed` about **10.6 ms after cleanup acknowledgement** and **10.4 ms after release dispatch**. The probe first read the new line at 1790590239.857944. |
| Observation end | 1790590242.827573 | Replacement remained denied at every sampled check through the 3 second interval. Parent and child had exited by the first post-release process sample; the post-clean effect establishes that a writer could still act after the cleanup response. |

The background-terminal registry becoming empty and `clean` returning successfully did **not** establish a quiescent writer boundary. The delayed effect may be an asynchronous termination race; this probe cannot distinguish a process that outlived cleanup for milliseconds from another runtime path that allowed its pending write. Either way, releasing writer/capacity holds at that acknowledgement would have admitted replacement before the delayed effect. This candidate therefore fails the required safe-release proof. No further S01 probes were run.

### Cleanup and limits

The independent oracle process was stopped after observation. The fixture's writer PIDs were checked against their captured birth/command identities before any emergency signal; neither writer was still present, so no exact-PID kill was needed. The probe killed its own App Server process group (PID 59976) and waited for exit `-9`. Final `ps` checks found PIDs 59976, 60260, 60336 and the oracle PID 59975 absent. SQLite `PRAGMA integrity_check` returned `ok`; its durable row remained `stopping, 1, 1, 1`. The disposable fixture and schema were removed after traces were copied. No hold was released.

This single timing result does not prove all runtime behavior. Explicit Stop, race-safe release, recovery, and the remaining `docs/delivery.md` probes remain unproved. A different contract or runtime termination mechanism needs a separate decision before product implementation proceeds.
