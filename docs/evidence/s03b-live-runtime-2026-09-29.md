# S03b bounded live-runtime evidence

**Result: passed with limits.** This evidence qualifies a direct turn, a normal
follow-up in the same Codex conversation, and a task Stop against the existing
operator login. It does not qualify physical sleep/wake or exact execution
recovery after a host/service restart.

## Source and runtime identity

Command:

```sh
PATH=/private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin:$PATH \
  /private/tmp/ensemble-node.T1JoRI/node-v24.21.0-darwin-arm64/bin/node \
  /private/tmp/ensemble-node.T1JoRI/npm-12.1.0/package/bin/npm-cli.js \
  run s03b:live
```

The live harness required its explicit `--live` opt-in through that package
script. It reported:

- Source HEAD: `95878b7ce7cc04e7a203133a4752c0292dcb9c3f`.
- Source working tree was intentionally dirty. Tracked-diff SHA-256:
  `7cbb56c640bd33e901e4ce50c426fed03fe56d56d31016bd324e1dd59138a99d`.
- Untracked-source SHA-256:
  `bcb30ac3cfcd86dabe6ff0c63952466c4f6145e1b92f39dae458af61c2685b56`.
- Combined working-tree SHA-256:
  `8a3bb474659fa7d302fa3f81e812d63f33b48c483a3ff144bf93c9705cff2881`.
- Node `v24.21.0`; npm `12.1.0`, invoked from
  `/private/tmp/ensemble-node.T1JoRI/npm-12.1.0/package/bin/npm-cli.js`.
- Codex CLI `0.159.0`; App Server process identity was PID `83963`, start
  `Tue Sep 29 22:42:22 2026`, boot ID
  `F899F669-079B-4A1A-AE7B-D0FBDF33047C`.

The digest covers the tracked diff from HEAD and the sorted contents of the
untracked source files present at run time. It predates this evidence document.
After the live probe, the local review made one behavior-preserving cleanup to
the stopped-scheduler fast path (`return Promise.resolve()` to `return` in the
async method). The affected scheduler suite was rebuilt and rerun 8/8; the
bounded live probe was not repeated for that equivalent early return.

## Observations

| Probe | Observed result |
| --- | --- |
| Direct turn | `s03b-live-first-f7f6eece-750c-4598-84f6-c8bdaf9a0c31` completed on thread `01a0ef1e-6c52-7021-8dc7-4e95705874af`, turn `01a0ef1e-6d70-70c0-a171-296c3d3b9094`. |
| Normal handoff | `s03b-live-followup-27737ad7-931f-43a7-92cf-3b32279989da` completed on the same thread, with new turn `01a0ef1e-7c47-7421-b641-87134b9773ad`. |
| Task Stop | Work `assignment:92984f5a-388b-4b64-b5f6-d9d7f7bb8e49:initial`, thread `01a0ef1e-849b-7372-a271-781afb1d9baf`, turn `01a0ef1e-8516-7712-bb04-2ec8243374f2`: interrupt acknowledged; terminal observed within the configured 3000 ms window; execution remained `held` under the independent Stop hold. |
| Power view at completion | No assertion failure and no power admission hold were reported. Active-only assertion behavior is covered by deterministic tests; this view does not expose whether the assertion child was active during the turn. |

The harness created and removed its temporary Ensemble data and workspace
directories (`fixtureCreated=true`, `fixtureRemoved=true`). It did not change
the shared Codex login/configuration, reboot, force-unlock, deploy or cut over.
The probe created three Codex turns in two provider threads; those provider
threads remain in the existing account because the runtime exposes no deletion
operation. No current user task was retried.

## Unproved limits

- The live adapter deliberately returns `unknown` for startup execution
  inspection: current Codex App Server history cannot prove exact original
  execution liveness or termination. T4 recovery release is therefore qualified
  by deterministic exact-identity/verifier tests, not this live run.
- No physical sleep/wake or reboot was attempted. The macOS event-source and
  admission-gate behavior is covered by deterministic fixtures only.
- The local operator UI and authenticated remote shell remain outside #691.
- The script asks the model not to use tools, but the live observation does not
  provide independent tool-history proof. It does not claim that broader policy
  or workspace isolation has been qualified.
