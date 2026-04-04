# Human Interaction Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class blocked-on-human workflow support so Ensemble can persist interaction requests, expose them in the API and UI, and resume blocked issues predictably.

**Architecture:** Implement this as an additive file-backed subsystem in `ensemble-core`. The runtime change starts in the agent/worker boundary, flows through `PipelineRun` and `OrchestratorState`, persists `InteractionRequest` records under the config directory, and exposes operator actions through new axum endpoints and dashboard views. The first version supports one open blocking interaction per issue, manual resume, and one-way tracker mirroring.

**Tech Stack:** Rust 2021, tokio, serde/serde_json, axum, utoipa/OpenAPI, React 19, TanStack Query, Orval-generated API client, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `crates/ensemble-core/src/interaction/mod.rs` | Create | Interaction domain model, persistence path helpers, and storage facade exports |
| `crates/ensemble-core/src/interaction/model.rs` | Create | `InteractionRequest`, `InteractionKind`, `InteractionStatus`, `InteractionResponse` |
| `crates/ensemble-core/src/interaction/store.rs` | Create | JSON-file persistence under `<config_dir>/state/interactions/` |
| `crates/ensemble-core/src/interaction/error.rs` | Create | `InteractionError` for API and orchestrator operations |
| `crates/ensemble-core/src/lib.rs` | Modify | Export the new `interaction` module |
| `crates/ensemble-core/src/error.rs` | Modify | Add `InteractionError` plumbing to shared error types if needed |
| `crates/ensemble-core/src/config/ensemble.rs` | Modify | Add additive `human_interaction` config block with defaults |
| `crates/ensemble-core/src/config/location.rs` | Modify | Add helper for the interactions state directory under the config dir |
| `crates/ensemble-core/src/agent/events.rs` | Modify | Add blocked worker result payload for interaction requests |
| `crates/ensemble-core/src/agent/mod.rs` | Modify | Detect `.ensemble/interaction-request.json`, write `.ensemble/interaction-response.json`, inject `interaction_response` prompt context |
| `crates/ensemble-core/src/pipeline/engine.rs` | Modify | Add `StepState::BlockedOnHuman`, `PipelineAction::BlockedOnHuman`, and tests |
| `crates/ensemble-core/src/orchestrator/state.rs` | Modify | Track waiting-on-human issues and associated interaction IDs |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Modify | Handle blocked worker exits, persist interactions, release running slots, and resume issues |
| `crates/ensemble-core/src/observability/snapshot.rs` | Modify | Surface waiting interactions in runtime and issue detail snapshots |
| `crates/ensemble-core/src/api/mod.rs` | Modify | Export interaction API module |
| `crates/ensemble-core/src/api/router.rs` | Modify | Register interaction and resume routes |
| `crates/ensemble-core/src/api/openapi.rs` | Modify | Document new endpoints and schemas |
| `crates/ensemble-core/src/api/interaction.rs` | Create | `GET /interactions`, `GET /interactions/{id}`, `POST /interactions/{id}/respond`, `POST /interactions/{id}/cancel` |
| `crates/ensemble-core/src/api/controls.rs` | Modify | Add `POST /issues/{identifier}/resume` or equivalent issue-resume control |
| `crates/ensemble-core/tests/api_endpoints.rs` | Modify | Add integration coverage for interaction endpoints and resume behavior |
| `crates/ensemble-ui/src-ui/src/hooks.ts` | Modify | Add wrappers for generated interaction and resume hooks |
| `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx` | Modify | Add pending interaction queue section |
| `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx` | Modify | Add interaction panel and resume controls |
| `crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx` | Create | Dashboard list of open interaction requests |
| `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx` | Create | Issue detail interaction view and response form |
| `crates/ensemble-ui/src-ui/src/generated/api/**` | Regenerate | Generated client/types from updated OpenAPI spec |
| `crates/ensemble-core/src/pipeline/verdict.rs` | Review only | Confirm verdict fallback still composes cleanly with interaction file detection |

---

### Task 1: Add the Interaction Domain Model and File Store

**Files:**
- Create: `crates/ensemble-core/src/interaction/mod.rs`
- Create: `crates/ensemble-core/src/interaction/model.rs`
- Create: `crates/ensemble-core/src/interaction/store.rs`
- Create: `crates/ensemble-core/src/interaction/error.rs`
- Modify: `crates/ensemble-core/src/lib.rs`
- Modify: `crates/ensemble-core/src/error.rs`
- Modify: `crates/ensemble-core/src/config/location.rs`

- [ ] **Step 1: Write the failing unit tests for the interaction store**

Add tests that cover:

```rust
#[tokio::test]
async fn saves_and_loads_interaction_request() {}

#[tokio::test]
async fn lists_only_open_interactions() {}

#[tokio::test]
async fn rejects_invalid_response_for_kind() {}

#[tokio::test]
async fn cancels_existing_interaction() {}
```

The tests should use `tempfile` and assert one-file-per-interaction JSON persistence under a `state/interactions` directory.

- [ ] **Step 2: Run the new interaction store tests and verify they fail**

Run:

```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```

Expected: FAIL because the `interaction` module and store do not exist yet.

- [ ] **Step 3: Implement the minimal interaction model and persistence layer**

Create:

```rust
pub enum InteractionKind { Question, Approval, Handoff }
pub enum InteractionStatus { Open, Resolved, Cancelled }
pub enum InteractionResponse { ... }
pub struct InteractionRequest { ... }
pub struct InteractionStore { ... }
pub enum InteractionError { ... }
```

Implement JSON read/write helpers that:

```text
- store each interaction as <config_dir>/state/interactions/<id>.json
- create parent directories lazily
- list interactions by scanning the directory
- validate response payload kind before writing resolved state
- expose small helper methods: create, get, list_open, resolve, cancel
- reject creating a new open blocking interaction for an issue that already has one
```

The store should make the single-open-blocking-interaction invariant explicit so later orchestrator and API code cannot accidentally create conflicting requests for the same issue.

- [ ] **Step 4: Run the interaction store tests and verify they pass**

Run:

```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```

Expected: PASS for the new interaction model and store tests.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/interaction crates/ensemble-core/src/lib.rs crates/ensemble-core/src/error.rs crates/ensemble-core/src/config/location.rs
git commit -m "Add interaction request model and store"
```

---

### Task 2: Add Config Support for Human Interaction

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Write the failing config tests**

Add tests for:

```rust
#[test]
fn parses_human_interaction_defaults() {}

#[test]
fn parses_manual_resume_mode_from_yaml() {}
```

The default should be `enabled: true` and `default_resume_mode: manual`.

- [ ] **Step 2: Run the config tests and verify they fail**

Run:

```bash
cargo test -p ensemble-core human_interaction -- --nocapture
```

Expected: FAIL because the config structs do not exist yet.

- [ ] **Step 3: Add the config types and defaults**

Add a small additive config block:

```rust
pub struct HumanInteractionConfig {
    pub enabled: bool,
    pub default_resume_mode: String,
}
```

Keep the first version intentionally narrow:

```text
- no step-level approval config yet
- no max pending interaction limit yet
- no blocked-on-human cycle accounting knobs yet
```

- [ ] **Step 4: Run the config tests and OpenAPI generation test**

Run:

```bash
cargo test -p ensemble-core human_interaction test_openapi_spec_generates -- --nocapture
```

Expected: PASS and OpenAPI still serializes.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/api/openapi.rs
git commit -m "Add human interaction runtime config"
```

---

### Task 3: Extend Agent Worker Results for Blocked-On-Human Exits

**Files:**
- Modify: `crates/ensemble-core/src/agent/events.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/agent/events.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Write failing tests for interaction request detection**

Add tests that cover:

```rust
#[tokio::test]
async fn detects_interaction_request_file_and_returns_blocked_result() {}

#[tokio::test]
async fn prefers_interaction_request_over_approve_reject_verdict_mix() {}

#[tokio::test]
async fn writes_interaction_response_file_before_resume_prompt_render() {}
```

- [ ] **Step 2: Run the agent tests and verify they fail**

Run:

```bash
cargo test -p ensemble-core agent:: -- --nocapture
```

Expected: FAIL because `WorkerResult` and prompt rendering do not support interactions yet.

- [ ] **Step 3: Extend worker results and implement file detection**

Update `WorkerResult` to add a blocked payload, for example:

```rust
BlockedOnHuman {
    request: InteractionRequestDraft,
}
```

Implement:

```text
- parse `.ensemble/interaction-request.json` after agent completion
- reject malformed request files with a normal failure path
- do not accept a mixed "verdict + interaction request" exit
- write `.ensemble/interaction-response.json` before a resumed rerun when a response exists
- extend prompt rendering input so templates can reference `interaction_response`
```

Keep this minimal by threading only the latest resolved blocking response into the prompt context.

- [ ] **Step 4: Run the agent tests and verify they pass**

Run:

```bash
cargo test -p ensemble-core agent:: -- --nocapture
```

Expected: PASS for the new blocked-on-human worker path.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/agent/events.rs crates/ensemble-core/src/agent/mod.rs
git commit -m "Detect blocked-on-human agent exits"
```

---

### Task 4: Extend the Pipeline Engine for Blocked Steps

**Files:**
- Modify: `crates/ensemble-core/src/pipeline/engine.rs`
- Test: `crates/ensemble-core/src/pipeline/engine.rs`

- [ ] **Step 1: Write failing pipeline engine tests**

Add tests that assert:

```rust
#[test]
fn blocked_step_sets_blocked_state() {}

#[test]
fn blocked_step_returns_blocked_pipeline_action() {}

#[test]
fn blocked_step_is_not_terminal_success_or_failure() {}
```

Include one test that verifies downstream steps are not dispatched while a dependency is blocked.

- [ ] **Step 2: Run the pipeline engine tests and verify they fail**

Run:

```bash
cargo test -p ensemble-core pipeline::engine -- --nocapture
```

Expected: FAIL because `StepState::BlockedOnHuman` and `PipelineAction::BlockedOnHuman` do not exist yet.

- [ ] **Step 3: Implement the blocked state path**

Add:

```rust
StepState::BlockedOnHuman { interaction_request_id: String }
PipelineAction::BlockedOnHuman { step: String, interaction_request_id: String }
```

Implement a dedicated step transition helper instead of overloading verdict handling. Preserve existing approve/reject behavior unchanged for normal runs.

- [ ] **Step 4: Run the pipeline engine tests and verify they pass**

Run:

```bash
cargo test -p ensemble-core pipeline::engine -- --nocapture
```

Expected: PASS with the new blocked transition tests.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/pipeline/engine.rs
git commit -m "Add blocked-on-human pipeline state"
```

---

### Task 5: Extend Orchestrator State and Blocked-Issue Lifecycle

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/scheduler.rs`
- Test: `crates/ensemble-core/src/orchestrator/state.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/src/orchestrator/scheduler.rs`

- [ ] **Step 1: Write failing orchestrator tests for blocked issues**

Add tests that cover:

```rust
#[tokio::test]
async fn blocked_issue_releases_running_slot_and_stays_claimed() {}

#[tokio::test]
async fn blocked_issue_persists_interaction_and_does_not_schedule_retry() {}

#[tokio::test]
async fn resume_requeues_resolved_blocked_issue() {}

#[tokio::test]
async fn resume_fails_when_step_name_no_longer_exists() {}

#[test]
fn resumed_waiting_issue_is_dispatch_eligible_even_while_claimed() {}
```

- [ ] **Step 2: Run the orchestrator tests and verify they fail**

Run:

```bash
cargo test -p ensemble-core orchestrator:: -- --nocapture
```

Expected: FAIL because the orchestrator has no waiting-on-human path yet.

- [ ] **Step 3: Implement waiting-on-human state management**

Extend `OrchestratorState` with a small waiting map keyed by issue ID, holding at minimum:

```rust
issue_id
identifier
interaction_request_id
step_name
requested_at
```

Update `handle_worker_exit` so that when a worker returns blocked:

```text
- persist the interaction request through InteractionStore
- transition the pipeline step to BlockedOnHuman
- remove the issue from running
- add runtime seconds from the completed running entry
- keep the issue claimed in a dedicated waiting set
- do not schedule failure retry
- optionally mirror tracker state/comment
```

Implement a resume helper that:

```text
- verifies the interaction is resolved
- verifies the step and agent still exist in the current DAG/config
- recreates the workspace if necessary
- redispatches the blocked step only
- removes the waiting entry once dispatch succeeds
```

Update scheduler or eligibility logic so a resolved waiting issue can be resumed safely without relying on the normal unclaimed-candidate path. The resumed path must either:

```text
- bypass the usual claimed-issue filter for explicit resume requests, or
- clear and restore the claim in a controlled way before redispatch
```

Prefer the first option so explicit resume stays separate from normal tracker polling.

- [ ] **Step 4: Run the orchestrator tests and verify they pass**

Run:

```bash
cargo test -p ensemble-core orchestrator::scheduler orchestrator::state orchestrator:: -- --nocapture
```

Expected: PASS for blocked lifecycle tests and no regressions in existing retry behavior.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/state.rs crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/orchestrator/scheduler.rs
git commit -m "Handle blocked-on-human orchestrator state"
```

---

### Task 6: Add Runtime Snapshots for Waiting Interactions

**Files:**
- Modify: `crates/ensemble-core/src/observability/snapshot.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Test: `crates/ensemble-core/src/observability/snapshot.rs`

- [ ] **Step 1: Write failing snapshot tests**

Add tests that assert runtime and issue-detail snapshots include waiting interaction data.

Suggested shapes:

```rust
#[test]
fn runtime_snapshot_includes_waiting_interaction_count() {}

#[test]
fn issue_detail_snapshot_includes_current_interaction_summary() {}
```

- [ ] **Step 2: Run the snapshot tests and verify they fail**

Run:

```bash
cargo test -p ensemble-core observability::snapshot -- --nocapture
```

Expected: FAIL because snapshot structs do not expose interaction data yet.

- [ ] **Step 3: Extend snapshot structs minimally**

Add:

```text
- a waiting interaction count to RuntimeSnapshot counts
- a list or summary row for open blocking interactions on the dashboard snapshot
- current interaction summary on IssueDetailSnapshot
```

Keep the first version compact. Do not dump full response bodies into the global state snapshot.

- [ ] **Step 4: Run the snapshot tests and verify they pass**

Run:

```bash
cargo test -p ensemble-core observability::snapshot -- --nocapture
```

Expected: PASS with the new snapshot fields.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/observability/snapshot.rs crates/ensemble-core/src/api/handlers.rs
git commit -m "Expose waiting interactions in runtime snapshots"
```

---

### Task 7: Add Interaction API Endpoints and Resume Control

**Files:**
- Create: `crates/ensemble-core/src/api/interaction.rs`
- Modify: `crates/ensemble-core/src/api/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Write failing API endpoint tests**

Add integration tests for:

```rust
#[tokio::test]
async fn list_open_interactions() {}

#[tokio::test]
async fn get_interaction_by_id() {}

#[tokio::test]
async fn respond_to_question_marks_interaction_resolved() {}

#[tokio::test]
async fn cancel_interaction_returns_conflict_when_already_resolved() {}

#[tokio::test]
async fn resume_blocked_issue_requeues_issue() {}
```

- [ ] **Step 2: Run the API integration tests and verify they fail**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints -- --nocapture
```

Expected: FAIL because the routes and schemas do not exist yet.

- [ ] **Step 3: Implement the interaction handlers and routes**

Add endpoint handlers with the existing `ApiError` envelope style:

```text
GET  /api/v1/interactions
GET  /api/v1/interactions/{id}
POST /api/v1/interactions/{id}/respond
POST /api/v1/interactions/{id}/cancel
POST /api/v1/issues/{identifier}/resume
```

Implementation requirements:

```text
- use 200 for successful reads/responses
- use 400 for invalid response body
- use 404 for missing interaction or issue
- use 409 for already-resolved, already-cancelled, or invalid resume state
- notify the orchestrator refresh channel after successful resume
```

- [ ] **Step 4: Regenerate OpenAPI spec and verify generated docs include new endpoints**

Run:

```bash
cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored
```

Expected: PASS and the generated spec contains the new interaction paths.

- [ ] **Step 5: Run the API tests and verify they pass**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints -- --nocapture
```

Expected: PASS for interaction and resume endpoints.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/api crates/ensemble-core/tests/api_endpoints.rs
git commit -m "Add interaction and resume API endpoints"
```

---

### Task 8: Regenerate Frontend API Client and Add Hook Wrappers

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Regenerate: `crates/ensemble-ui/src-ui/src/generated/api/**`
- Regenerate: `crates/ensemble-ui/src-ui/src/generated/models/**`

- [ ] **Step 1: Regenerate the OpenAPI client and inspect the generated output**

Run:

```bash
pnpm --dir crates/ensemble-ui/src-ui run codegen
```

Expected: PASS and new generated interaction hooks/models appear.

- [ ] **Step 2: Write or update hook wrapper expectations in `hooks.ts`**

Add wrappers similar to the existing query/mutation helpers:

```text
- useInteractionsQuery
- useInteractionDetailQuery
- useRespondToInteractionMutation
- useCancelInteractionMutation
- useResumeIssueMutation
```

Invalidate state and issue-detail queries after successful response or resume.

- [ ] **Step 3: Run TypeScript build to verify generated client integration**

Run:

```bash
pnpm --dir crates/ensemble-ui/src-ui run build
```

Expected: FAIL or PASS depending on whether UI pages already reference the new hooks; fix only hook-level typing issues in this task.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/hooks.ts crates/ensemble-ui/src-ui/src/generated
git commit -m "Generate interaction API client hooks"
```

---

### Task 9: Add Dashboard Interaction Queue UI

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/InteractionQueue.test.tsx`

- [ ] **Step 1: Write the failing component test**

Cover:

```tsx
it("renders open interaction rows with kind, title, step, and age")
it("shows an empty state when no interactions exist")
```

- [ ] **Step 2: Run the component test and verify it fails**

Run:

```bash
pnpm --dir crates/ensemble-ui/src-ui test -- InteractionQueue
```

Expected: FAIL because the component does not exist yet.

- [ ] **Step 3: Implement the queue component and dashboard section**

Render a compact table or list with:

```text
- issue identifier
- interaction kind
- title
- blocking flag
- step name
- age
```

Add a dashboard section beneath retry queue or near it. Keep the first version utilitarian and aligned with the existing dashboard style.

- [ ] **Step 4: Run the component test and dashboard build**

Run:

```bash
pnpm --dir crates/ensemble-ui/src-ui test -- InteractionQueue
pnpm --dir crates/ensemble-ui/src-ui run build
```

Expected: PASS and the dashboard compiles with the new section.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx crates/ensemble-ui/src-ui/src/components/InteractionQueue.test.tsx crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx
git commit -m "Show pending interactions on dashboard"
```

---

### Task 10: Add Issue Detail Interaction Panel and Resume Controls

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.test.tsx`

- [ ] **Step 1: Write the failing interaction panel tests**

Cover:

```tsx
it("renders question interactions with text response form")
it("renders approval interactions with approve and reject actions")
it("shows resume button only when interaction is resolved")
```

- [ ] **Step 2: Run the component test and verify it fails**

Run:

```bash
pnpm --dir crates/ensemble-ui/src-ui test -- InteractionPanel
```

Expected: FAIL because the panel does not exist yet.

- [ ] **Step 3: Implement the issue detail panel and mutation wiring**

Add:

```text
- current interaction summary in IssueDetail page
- response form chosen by interaction kind
- cancel action when appropriate
- explicit resume action after a resolved interaction
```

Keep the first version single-interaction only, matching the backend design.

- [ ] **Step 4: Run the component tests and full frontend build**

Run:

```bash
pnpm --dir crates/ensemble-ui/src-ui test -- InteractionPanel
pnpm --dir crates/ensemble-ui/src-ui run build
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx crates/ensemble-ui/src-ui/src/components/InteractionPanel.test.tsx crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx
git commit -m "Add issue interaction response controls"
```

---

### Task 11: End-to-End Verification and Cleanup

**Files:**
- Review: all touched files from Tasks 1-10

- [ ] **Step 1: Run focused Rust tests for interaction-related modules**

Run:

```bash
cargo test -p ensemble-core interaction::store pipeline::engine orchestrator:: api:: -- --nocapture
```

Expected: PASS.

- [ ] **Step 2: Run integration API tests**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints -- --nocapture
```

Expected: PASS.

- [ ] **Step 3: Run frontend tests and build**

Run:

```bash
pnpm --dir crates/ensemble-ui/src-ui test
pnpm --dir crates/ensemble-ui/src-ui run build
```

Expected: PASS.

- [ ] **Step 4: Run full workspace verification required by the repo**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 5: Review the implementation against the design doc**

Confirm all of the following:

```text
- one open blocking interaction per issue in v1
- JSON persistence under <config_dir>/state/interactions/
- blocked issues release running slots and do not consume max_cycles
- tracker mirroring is one-way only in v1
- response injection uses .ensemble/interaction-response.json plus prompt context
- UI/API support manual resolve and resume
```

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "Implement human interaction request workflow"
```
