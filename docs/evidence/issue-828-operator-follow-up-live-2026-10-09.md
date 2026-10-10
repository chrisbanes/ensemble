# #828 operator follow-up — bounded live attempts, 9 October 2026

This records the two granted actual-runtime attempts of
`test/wi828/live-operator-follow-up.mjs` for #828. Attempt 1 stopped on a
harness defect; after a harness-only repair Chris granted exactly one more
attempt, which passed. Neither attempt was retried.

## Summary

| Row | Attempt 1 | Attempt 2 |
| --- | --- | --- |
| Lead's initial turn reports a result and completes | Passed | Passed |
| Task read reports `leadFeedback.mode = "resumes"` | Passed | Passed |
| Review sent while paused: `resumedLead: true` receipt and operation read, lead pending at version 2, no new turn | Passed | Passed |
| Resumed turn continues the lead's thread at work revision 2 | Unproved | Passed |
| Its prompt carries the `assignment-follow-up` event, the comment and `retained anchor <id>` | Unproved | Passed |
| Lead writes `followup-ack.txt` with the anchor ID (model-dependent) | Unproved | Passed |
| Lead reports a result for the resumed work | Unproved | Passed |
| Exactly the planned starts; service stop and verified Codex process exit | Passed (one start) | Passed (two starts) |

## Attempt 1 inputs

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

## Repair after attempt 1

The script now plans T2 from the lead's single queued delivery batch and checks
that its work ID is `assignment:<lead>:v2:inbox:<first bound event>` and that
the batch includes the `assignment-follow-up` event. The deterministic
`operator-follow-up.test.ts` paused-review case checks the same batch shape
through the real scheduler. This is an ordinary test-harness repair: the product seam
the plan described held, and only the live script's work-ID derivation was
wrong. It does not count against the plan-mismatch budget and did not
replenish the attempt; Chris granted the second attempt separately.

## Attempt 2: passed

| Input | Value |
| --- | --- |
| Source revision | `8024e7cc22d0260c6ff28fc620b30cfac4dd7af4` (built `dist`) |
| Node / package manager | v24.21.0 / npm@12.2.0 |
| Runtime | Codex CLI `codex-cli 0.162.0-alpha.2`, sha256 `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` |
| Entry sha256 | `fbcec51d3a5bac761b4a2318c6e17758e43539d5b99d81e78868ba92e2570b95` |
| Window | 2026-10-09 20:15:35Z – 20:15:58Z |

Before the attempt, no process referenced attempt 1's retained fixture, and
attempt 2 used its own new fixture, database and checkpoint directories, so
the retained fixture could not interfere. It was left in place.

- T1: the lead wrote `marker-1.txt`, reported a result and completed at
  version 1.
- The operator's review of `marker-1.txt`, sent while the project was paused,
  was recorded with `resumedLead: true` (receipt and operation read). The lead
  moved to pending at version 2 and no turn started.
- The scheduler bound one queued delivery batch holding the lead's earlier
  `assignment-result` event and the `assignment-follow-up` event. T2's work ID
  was `assignment:<lead>:v2:inbox:<first bound event>`, as expected.
- T2 ran on the same Codex thread as T1, at work revision 2. Its prompt
  contained the `assignment-follow-up` event, the review comment and
  `retained anchor <id>` for the staged anchor.
- The lead wrote `followup-ack.txt` containing exactly that anchor ID and
  reported a result for the resumed work.
- Exactly two `startTurn` calls; the third harness slot stayed unused; no
  refused starts or deviations. Service stop returned and the Codex process
  exit was verified (`mac-pid-absent-same-boot`). The fixture is retained
  privately.
