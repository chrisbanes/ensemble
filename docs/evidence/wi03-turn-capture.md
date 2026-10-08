# WI03 bounded live turn-capture evidence

**Result: passed for one repository-free actual journey.** This record covers
the guarded #780 T5 journey at source commit
`b5b4663da2bd88c801015a1849fd560110fd0a1f`. It follows the
[published #780 plan](https://github.com/chrisbanes/ensemble/issues/780#issuecomment-6050732630)
and the [server comparison and turn-capture contract](../SPEC.md#780-server-comparison-and-turn-capture).

## Source and runtime

The guarded entry was `test/wi03/live-turn-capture.mjs`, SHA-256
`6c9cedc8c6e0e62105f99fcd2dd2423544193d9c619e7cc0d1107242c5772ddb`.
The compiled Codex adapter hash was
`bcc28b8af1df12eff5e4f63baaed96d241b3ebde67147ab5b037d08dd2e2806f`.
The run used Node `v24.21.0`, npm `12.2.0`, and bundled Codex CLI
`0.162.0-alpha.2`. The approved launcher SHA-256 was
`50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8`; its
resolved executable SHA-256 was
`cb4e4994627e770800a940b42969c77855a3fc09a6e60b02aa6319f670d6b6ab`.

Before dispatch, the real runtime read validated the ChatGPT account and
configuration (`approvalPolicy=never`, `sandboxMode=workspace-write`). The
project was paused, the service supplied its runtime safety and spawn
environment, runtime startup returned, and the attempt guard recorded zero
turn starts. One runtime generation and one Codex process identity were
observed.

## Observed journey

The entry made exactly one `Runtime.startTurn` call. The synthetic task was
`cf69e32f-fd94-411a-8a1a-860bec125199`; work
`assignment:a0a214be-4b92-4811-b8b0-72ac7d2edc90:initial`; assignment
`a0a214be-4b92-4811-b8b0-72ac7d2edc90`; profile
`a0df0541-a961-453c-bc7a-f461b1eb28c5`; thread
`01a11a74-f4a3-7c32-8aa0-55e7d2dc2e19`; turn
`01a11a74-f5da-7f23-b946-0a6ae0bd2deb`.

The turn reached terminal `completed`; its result callback and handoff settled
the exact work as `completed`. No task hold or running work remained at
shutdown. Capture `f6233fc6-addc-4ada-8187-84fbc0b895bc` was
`finished/completed`, with observation interval
`2026-10-08T07:40:34.812Z`–`2026-10-08T07:40:44.674Z`.

Before the turn, `turn-marker.txt` was absent. The successful turn wrote the
exact UTF-8 bytes `ensemble-turn-capture-marker-v1\n`, with SHA-256
`9df6515b514318f81c862bc5b96186c51f1adc2bc79e78bb3d990ffe348ac04c`.
The capture asserted the left side absent and the right-side hash exact; its
export contained the same marker text. An authenticated last-turn request
returned HTTP 200 and `available` for the same task, work, profile, thread,
turn and comparison, without exposing the workspace path.

After service stop, the same SQLite database was reopened read-only. The
persisted identity, full comparison payload and side exports matched the
captured values; the marker bytes were unchanged. The capture row remained
`finished`, `latestFinishedId` remained the comparison ID, and `pendingId` was
null.

One runtime process identity was verified exited on the same boot by PID
absence: PID `48349`, birth `Thu Oct 8 08:40:33 2026`, boot ID
`F899F669-079B-4A1A-AE7B-D0FBDF33047C`, exit verified at
`2026-10-08T07:40:44.850Z`. The bounded shutdown returned for both runtime and
service; exit was verified 45 ms after shutdown was requested, within its
10-second bound. Proof-gated cleanup then removed the fixture; no partial
fixture was retained. The attempt ended `shutdown-verified` with no failure or
recovery failure.

## Attempt accounting and limits

An earlier `--live` entry invocation failed during static ESM linking before
module evaluation. It started no runtime or turn and created no fixture. That
historical failure remains preserved; no attempt record was reset. This was
the one actual journey: one of one actual-runtime journeys used, with one
turn start.

This run proves one repository-free actual journey. Git comparison cases use
offline automated fixtures, including real temporary repositories. This run
does not establish a whole-response latency guarantee: the five-second
observation budget does not bound all awaited validation and cleanup. Exact
process exit does not prove descendants stopped or all filesystem effects
ended. It does not qualify repository-backed live Git, X or native visibility,
the operator UI, #781 result retention, or complete runtime tool history.
