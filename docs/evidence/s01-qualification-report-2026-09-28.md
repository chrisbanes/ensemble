# S01 qualification report — 28 September 2026

This durable report preserves the later investigation's bounded observations for
assessment against the [seven S01 rows](https://github.com/chrisbanes/ensemble/issues/688) from a
fresh checkout. It supplements the [earlier evidence matrix](s01-existing-evidence-2026-09-28.md).
It records reported results, not new experiments or an S01 acceptance decision.

## Provenance

The source report was inspected read-only at local evidence head
`77a383fd64144df83dcc65f7b1888286d1f39b55` on `cb/35-s01-proof`, in
`docs/evidence/s01-minimum-contract-qualification-2026-09-28.md`. It includes
minimum-policy/recovery probes at `3092fcc1ce29a1687ae0cb07324a895f18d1e07d`,
native-history follow-up at `b085bc992bbaf4cc47a4cf79c9aa38d36f595f8a`, and
model-policy follow-up at `89f6f8408fbe2bb4a02cb755378d7b24ff9914de`.
Its merged contract baseline was `f0eaabdb30d34aad745771592f175d097ec9678a`;
the original runtime-source base was `8e3ab9387389f5040631cd06e2156186aaffbc6c`.
These IDs identify local provenance, not reachable published commits.

The observed environment was Codex CLI 0.157.1 on macOS 26.7 arm64, using the
existing ChatGPT login; the model-policy turns reported `gpt-6-sol`. Fixtures used
Python 3.9.6 and SQLite 3.51.0. Node 24.19.0/npm 11.17.0 did not match the
repository pins, so these Python/runtime probes did not qualify the product build.

## Coverage and limits

“Observed” denotes the source report's bounded result. Fixture results remain
separate from real runtime results. The earlier matrix supplies the historical
provenance and limits for rows reused without new probes.

| S01 row | Preserved evidence | Limits and remaining disposition |
| --- | --- | --- |
| Authenticated lifecycle — R01/A18 | Existing-login real turns completed; native command items appeared live and in stored history. A fresh App Server resumed the same thread and executed a second policy turn. Prior isolated no-login detection remains recorded in the earlier matrix. | Existing operator context only. Expired-login handling and installed-service startup/login holds belong to S02/S05. |
| Trusted caller — A25 | Earlier real dynamic-tool callback rejected spoofed assignment identity. New SQLite fixture accepted trusted thread A/generation 2/assignment A and rejected payload B, old generation, unbound thread and invalidated binding. | New stale/unbound checks are fixtures, not fresh callbacks. Pin the experimental callback surface; S04/S05 qualify product authorization. |
| Admission/durable state — A14/A16 | Earlier SQLite serialization admitted one contender, retained holds across reopen and covered storage rollback, initialization/policy failure, pause, Stop, capacity and service absence. | Coordination feasibility only; S03/S05 qualify every actual service admission path and race. |
| Ambiguous submission — A08/A09 | Earlier real lost turn-start response retained uncertainty. New fixture kept one durable dispatch and writer/capacity holds for missing/multiple matches before binding, missing/conflicting matches after binding and stale revision; integrity check passed. Earlier result/acknowledgement-loss fixture retained one event. | Match facts are synthetic. A unique fixture match did not release holds. Live reattachment and product send/inbox recovery remain unproved and do not become passes here. |
| Cancellation/survival — A15 | Earlier real writer survived App Server death and interrupt; Stop was persisted before cancellation, observation was bounded, and durable holds denied replacement across reopen. | Stronger termination failed. Recovery procedure and integrated cancellation remain S03/S05 work; no timeout unlock. |
| Cooperative handoff — A16/A18 | Earlier identified successful real turn and ended registered tool fed a SQLite fixture admitting one successor; nine negative cases retained holds. A detached child overlapped that successor. | Overlap remains an accepted limit. The source report held this row for exhaustive observations; that prerequisite is superseded by the approved trust boundary. Coordinator must assess coverage of the amended terminal-status/callback rule, not infer a new pass from this publication. |
| Effective policy/observations — A25/R01 | Two later model-originated shell turns, before/after server restart, had correlated live/stored command items and independently checked inside writes, denied sibling/symlink/temp writes and denied loopback connection. Details below. | Selected shell path only. No escalation request was exercised. Ordinary file edits and broader enabled-tool policy remain S02–S05 checks. Broad reads and ambient credentials/tools remain disclosed limits. |

## Selected shell-policy and history evidence

The recorded command was
`python3 test/s01/model_policy_probe.py ../.s01-model-policy-20260928-a`.
The script and raw trace are not included here; this command records what ran,
not a runnable instruction in this checkout. Budget was two real turns, zero
reruns; both ran after deterministic schema and shell-template checks.

Both isolated servers selected per-process `approval_policy=never` and
`sandbox_mode=workspace-write`. Thread start/resume selected the same policy;
each turn explicitly supplied `workspaceWrite`, the disposable writable root,
`networkAccess:false`, `excludeSlashTmp:true`, `excludeTmpdirEnvVar:true`, working
directory and `approvalPolicy:never`. Shared configuration/login were unchanged.

The first model command was `/bin/zsh -lc 'sh ./policy_case.sh first'`; after
server restart and same-thread resume, it was `sh ./policy_case.sh second` through
the same shell. At Unix times 1790611708.695 and 1790611721.175, the respective
native items `exec-8b02cf7d-feb9-4a77-89cb-a8d3241b9697` and
`exec-35b55db6-acec-4828-b544-7d55acc85e87` completed. Stored history matched
item IDs, commands, working directories, output and exit status for both turns.

Each command reported inside-write exit 0; sibling, symlink, synthetic temporary
root and `/tmp` writes each exited 1; loopback `curl` exited 7. Inside markers
existed, forbidden targets did not, and the listener received no model connection.
A host control had connected successfully. No approval request was observed;
the bounded policy result rests on explicit settings and denied effects, not
that absence. The script hash remained unchanged across both turns.

The source records script SHA-256
`37c6462a3787e391ed3aef479daec91d67e519be305bafcb1a2eafd79128aefb`
and trace SHA-256
`bf5e115d06d367004a778d6230b0d57bf76ea7bbb08fdbd25685418d44f73265`.
The listener closed; both owned servers exited, and exact-PID checks found neither
alive. Disposable inside markers remained for audit. This cleanup observation is
not a proof of complete descendant containment.

## Unresolved finding and acceptance boundary

An earlier turn completed and left an inside marker without a `commandExecution`
item in its recorded live/stored history. Its recorder retained only selected
notification methods and command history fields. The cause remains unknown; later
successful history probes do not explain or relabel that result. Under the
[approved trust boundary](../design/standalone.md#runtime-trust-boundary), missing
diagnostic items alone do not block normal handoff. A demonstrated selected-policy
breach, known unfinished execution or conflicting terminal outcome still does.

This published report makes the existing bounded observations available for
reconciliation without the private checkout. The original scripts/raw traces are
not published, so independent replay or deeper diagnosis still needs those
artifacts or separately bounded probes. Do not use this report to qualify an
uncovered case. The coordinator must record a disposition for each S01 row and
accept the candidate before S01 or its native dependencies are released.

## Subsequent S01 approval-evidence decision

On 28 September Chris approved the
[S01-only evidence amendment](https://github.com/chrisbanes/ensemble/issues/688).
The later sanitized candidate `e2145d69cb871645a97b56c617b1828c0c8ae976`
records one attempted escalation with no command item, approval request or forbidden
effect. That result remains inconclusive. S01 may use the existing effective-policy
and attributable write/network/history evidence while recording model-originated
escalation rejection as unproved. The product denial requirement is unchanged;
S02 owns deterministic unexpected-approval callback rejection and S05 the integrated
approval-flow tests. The evidence owner must reconcile the final candidate and
return it for review; this decision does not pass S01 or release downstream work.
