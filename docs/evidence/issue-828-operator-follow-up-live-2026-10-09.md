# #828 operator follow-up — bounded live attempt, 9 October 2026

This records the single granted actual-runtime attempt of
`test/wi828/live-operator-follow-up.mjs` for #828. The attempt was not
retried. Rows it did not reach are **unproved**, not passed.

## Inputs

| Input | Value |
| --- | --- |
| Source revision | `862988cb66f49c44faf223249c9246115a093111` (built `dist`) |
| Node / package manager | v24.21.0 / npm@12.2.0 |
| Runtime | Codex CLI `codex-cli 0.162.0-alpha.2`, sha256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` |
| Harness | `createInspectionJourneyHarness` / `InspectionJourneyGuard` (#782), unchanged; start limit 3, turn budget 300 s, total 1,200 s |
| Entry sha256 | `032f6494a35ed572a7551447984446df31bd88ee4dc2c235e1f884fe0e23f3ad` |
| Window | 2026-10-09 19:54:29Z – 19:54:42Z |

## Outcome: failed at the T2 planning step (harness defect)

| Row | Result |
| --- | --- |
| T1: the lead's initial turn writes `marker-1.txt`, reports a result and completes | **Passed.** Terminal `completed`; result recorded; lead `completed` at version 1 |
| Operator signs in over HTTP; the task read reports `leadFeedback.mode = "resumes"` | **Passed** |
| Local review on `marker-1.txt` sent while the project is paused | **Passed.** Receipt `recorded`, `resumedLead: true`; the operation read also carries `resumedLead: true`; lead `pending` at version 2; still one `startTurn` call |
| T2: the resumed lead turn continues the lead's thread and its prompt carries the `assignment-follow-up` event, the comment and `retained anchor <id>` | **Unproved.** Not attempted (see below) |
| Lead writes `followup-ack.txt` with the anchor ID and reports a result for work revision 2 | **Unproved.** Not attempted |
| Shutdown | **Passed.** Service stop returned; Codex process exit verified (`mac-pid-absent-same-boot`). One `startTurn` call; no refused starts or deviations |

The script planned T2's work ID from the lead's *pending* inbox events. The
scheduler had already bound those events into one queued delivery batch while
the project was paused, so none were pending and the script's assertion
stopped the journey before T2 was armed. Product behaviour matched the
contract; the planning query was wrong. The harness then stopped the service
with the resumed request queued and not admitted. The fixture directory is
retained privately.

## Repair after the attempt

The script now plans T2 from the lead's single queued delivery batch and checks
that its work ID is `assignment:<lead>:v2:inbox:<first bound event>` and that
the batch includes the `assignment-follow-up` event. The deterministic
`operator-follow-up.test.ts` paused-review case checks the same batch shape
through the real scheduler. This repair does not replenish the attempt; a
second attempt needs a new grant.
