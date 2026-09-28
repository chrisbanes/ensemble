# S01 trace publication sanitization — 28 September 2026

This publication branch starts from approved `f8b2305c04feafc4b3e8977ad3151938deac2219` and imports path-sanitized evidence. The earlier local evidence branch and its raw-trace commits are **not ancestors** of this publication branch. The original 32 JSON/JSONL files and their SHA-256 manifest remain in restricted task-local storage outside the repository; no raw original is included in this branch.

The text-only copy transformation replaced the specific task checkout prefix with `<workspace>`, its sibling Multica instance prefix with `<workspace-instance>`, and the user home prefix with `<user-home>`. It preserved JSON keys, record order, event IDs, timing, effects and outcomes. Historical report references to modified trace SHA-256 values were changed to the public-copy values below. This is a privacy correction, not a new runtime result or a change to the failed historical findings.

| Path-sanitized trace | Public-copy SHA-256 |
| --- | --- |
| `s01-current-install-retest-2026-09-28.jsonl` | `ac66cb10d792605f233689ccc625b5bf54e44186d481a487e34061220c4cec09` |
| `s01-minimum-policy-initial-trace-2026-09-28.jsonl` | `ab4566f61dcb6fcc19e67aba24ba546429cf54ff26c110107c3e0d11d9057bcf` |
| `s01-minimum-policy-trace-2026-09-28.jsonl` | `76d5aec0d4965a49881b9ef1ee351f763c50aa092a943ab8b916f86489b6e3c1` |
| `s01-minimum-turn-preflight-a-2026-09-28.jsonl` | `9e63b32bb44219fc7ee46aebf65215efd7cfd17b501a337c988a9191f7c0f9fe` |
| `s01-minimum-turn-preflight-b-2026-09-28.jsonl` | `a6131f0d2b7a586924246694e1dc98a8e073670634218bc81553780b80c55da5` |
| `s01-minimum-turn-trace-2026-09-28.jsonl` | `6eb721d56e345b80cd31e8bd3fd3a9dea44b2ed2be5c7fa5ccdacf151c653684` |
| `s01-model-policy-trace-2026-09-28.jsonl` | `bf5e115d06d367004a778d6230b0d57bf76ea7bbb08fdbd25685418d44f73265` |
| `s01-named-profile-list-trace-2026-09-28.jsonl` | `f6d9e2642b953da07497bde94939bb0d17e9da0cf342bcd987ac014f999c085b` |
| `s01-native-history-trace-2026-09-28.jsonl` | `95063e6a12d339cb521b59a324c36e201d77f6e60bf973864cb84983745739da` |
| `s01-r3-crash-2026-09-28.jsonl` | `d26956afaf269e552c63f4702b612d2473bd5542e2aa3f1da7b5b7094f15ef3e` |
| `s01-r3-stop-2026-09-28.jsonl` | `1d9b2af9c05c5908512840288390404166a617f8fcf291699ac1fab534f2f953` |
| `s01-r5-command-access-trace-2026-09-28.jsonl` | `ff1593cb84784bec0adfe7982c687bae38fb57040cc102f91b3369adf3941679` |
| `s01-race-1-2026-09-27.jsonl` | `59f07bb408ad4d3148ff64c27dc29e87b6849fd8565b74cf287b9a40dae9d5c1` |
| `s01-race-2-2026-09-27.jsonl` | `859e3e2ad64f5281cb23b2d7c234edfb4716d338b81e0b48bea5cc65d1b4fd18` |
| `s01-tree-2026-09-27.jsonl` | `d5b6e446c48af7de3754e085ff013d8874fa9eb0776f1c141b01515381f5b016` |

The one-turn escalation-attempt trace is new and separately summarized in the [historical fix-first section](s01-acceptance-candidate-2026-09-28.md#historical-watson-fix-first-broader-access-evidence). Its result remains inconclusive under the later [S01-only amendment](https://github.com/chrisbanes/ensemble/issues/688). All publishable JSON/JSONL copies must parse, and publication checks must find no absolute user/workspace prefix or Multica instance identifier in this branch. Git ancestry must be checked as well as the current tree; sanitizing only the latest commit would leave raw blobs reachable.
