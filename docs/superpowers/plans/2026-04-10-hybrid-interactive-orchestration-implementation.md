# Hybrid Interactive Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement first-class issue-scoped human input pauses (brainstorm/approval/decision) with UI-first resume flow while preserving orchestrator-driven state transitions.

**Architecture:** Build on the existing interaction + waiting-on-human infrastructure by introducing a normalized `pending_input` contract, issue-scoped submit endpoint, and explicit input lifecycle events. Keep persistence and restart hydration in `ensemble-core` and expose operator controls through Web/Tauri via existing API + generated client flow. Maintain current orchestrator tick boundaries: API writes intent, orchestrator performs resume transition.

**Tech Stack:** Rust 2021, tokio, serde/serde_json, axum, utoipa/OpenAPI, React 19, TanStack Query, Orval-generated API client, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `crates/ensemble-core/src/interaction/model.rs` | Modify | Normalize pause kinds and response payloads for brainstorm/approval/decision |
| `crates/ensemble-core/src/interaction/store.rs` | Modify | Enforce unresolved-prompt/idempotency guard and resume-safe persistence |
| `crates/ensemble-core/src/orchestrator/state.rs` | Modify | Keep issue-level waiting metadata and resume request queue semantics |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Modify | Emit lifecycle events (`input_requested/submitted/resumed`), apply resume on tick, preserve issue-scoped wait |
| `crates/ensemble-core/src/observability/snapshot.rs` | Modify | Add/normalize issue `pending_input` view and waiting counts |
| `crates/ensemble-core/src/api/controls.rs` | Modify | Add `POST /api/v1/issues/{identifier}/input` submit endpoint |
| `crates/ensemble-core/src/api/interactions.rs` | Modify | Keep compatibility path (if retained) and map to new model semantics |
| `crates/ensemble-core/src/api/openapi.rs` | Modify | Document new issue input endpoint and schemas |
| `crates/ensemble-core/src/timeline/mod.rs` | Modify | Add timeline event variants for input lifecycle |
| `crates/ensemble-core/tests/api_endpoints.rs` | Modify | End-to-end API tests for issue input submit conflicts/success |
| `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx` | Modify | Rename/shape “Pending Interactions” to “Needs Input” inbox |
| `crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx` | Modify | Show pause kind/context as “Needs Input” rows |
| `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx` | Modify | Render pending input details and submit/defer/cancel actions |
| `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx` | Modify | Simplify to prompt + response editor with pause kind badges |
| `crates/ensemble-ui/src-ui/src/hooks.ts` | Modify | Add hook for `POST /issues/{identifier}/input` and cache invalidation |
| `crates/ensemble-ui/src-ui/src/generated/api/**` | Regenerate | Sync client with OpenAPI changes |
| `docs/SPEC.md` | Modify | Update policy: no hard-fail on user input; issue-scoped waiting behavior |

---

### Task 1: Normalize Interaction Domain to Pending Input Semantics

**Files:**
- Modify: `crates/ensemble-core/src/interaction/model.rs`
- Modify: `crates/ensemble-core/src/interaction/store.rs`
- Test: `crates/ensemble-core/src/interaction/store.rs`

- [ ] **Step 1: Write failing model/store tests for new pause kinds and duplicate-submit guard**

Add tests:

```rust
#[tokio::test]
async fn stores_brainstorm_prompt_interaction() {}

#[tokio::test]
async fn reject_second_resolution_when_already_resolved() {}

#[tokio::test]
async fn list_awaiting_resume_returns_only_open_waiting_records() {}
```

- [ ] **Step 2: Run interaction tests to confirm failure**

Run:

```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```

Expected: FAIL on missing/changed kind semantics or unresolved guard behavior.

- [ ] **Step 3: Implement model updates with explicit pause kinds**

Apply minimal shape:

```rust
pub enum InteractionKind {
    BrainstormPrompt,
    ApprovalGate,
    ManualDecision,
}
```

Ensure serialization stays `snake_case` and store enforces one unresolved waiting interaction per issue.

- [ ] **Step 4: Re-run interaction tests**

Run:

```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/interaction/model.rs crates/ensemble-core/src/interaction/store.rs
git commit -m "Align interaction model with pending input semantics"
```

---

### Task 2: Wire Orchestrator Input Lifecycle Events and Resume Semantics

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/timeline/mod.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Add failing orchestrator tests for input lifecycle**

Add tests:

```rust
#[tokio::test]
async fn blocked_issue_emits_input_requested_and_stays_issue_scoped() {}

#[tokio::test]
async fn submit_input_emits_input_submitted_then_input_resumed_on_tick() {}

#[tokio::test]
async fn other_issues_continue_while_one_issue_waits_for_input() {}
```

- [ ] **Step 2: Run orchestrator tests to verify failure**

Run:

```bash
cargo test -p ensemble-core orchestrator::mod -- --nocapture
```

Expected: FAIL for missing lifecycle event assertions.

- [ ] **Step 3: Implement lifecycle timeline events and tick-driven resume**

Introduce event names:

```rust
InputRequested { issue_id, interaction_id, kind }
InputSubmitted { issue_id, interaction_id }
InputResumed { issue_id, interaction_id }
```

Keep behavior:
- API/store writes submission intent
- orchestrator tick performs resume transition
- waiting remains issue-scoped

- [ ] **Step 4: Run orchestrator tests again**

Run:

```bash
cargo test -p ensemble-core orchestrator::mod -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/orchestrator/state.rs crates/ensemble-core/src/timeline/mod.rs
git commit -m "Add pending input lifecycle events and resume semantics"
```

---

### Task 3: Add Issue-Scoped Input Submit API and Snapshot Contract

**Files:**
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Modify: `crates/ensemble-core/src/observability/snapshot.rs`
- Modify: `crates/ensemble-core/src/api/interactions.rs`
- Test: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Write failing API tests for issue input submit contract**

Add tests:

```rust
#[tokio::test]
async fn post_issue_input_succeeds_for_waiting_issue() {}

#[tokio::test]
async fn post_issue_input_returns_conflict_when_not_waiting() {}

#[tokio::test]
async fn issue_detail_snapshot_includes_pending_input_block() {}
```

- [ ] **Step 2: Run API tests to verify failure**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints issue_input -- --nocapture
```

Expected: FAIL since endpoint/schema are not yet implemented.

- [ ] **Step 3: Implement endpoint and snapshot shape**

Add endpoint:

```rust
POST /api/v1/issues/{identifier}/input
{ "response": "..." }
```

Snapshot addition:

```rust
pub struct PendingInputSummary {
    pub kind: String,
    pub prompt: String,
    pub requested_at: DateTime<Utc>,
    pub context: Option<...>,
}
```

Map interaction state to `pending_input` in issue detail responses.

- [ ] **Step 4: Run API and snapshot tests**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints issue_input -- --nocapture
cargo test -p ensemble-core observability::snapshot -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/api/openapi.rs crates/ensemble-core/src/observability/snapshot.rs crates/ensemble-core/src/api/interactions.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "Expose issue-scoped pending input API and snapshots"
```

---

### Task 4: Update Web/Tauri UI to Needs Input Workflow

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Test: `crates/ensemble-ui/src-ui/src/components/InteractionQueue.test.tsx`
- Test: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.test.tsx`

- [ ] **Step 1: Add failing UI tests for Needs Input labels and submit flow**

Add/adjust tests:

```tsx
it("renders Needs Input rows with pause kind badge", () => {})
it("submits response and disables submit while pending", async () => {})
it("shows defer and cancel controls", () => {})
```

- [ ] **Step 2: Run UI tests and confirm failure**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test InteractionQueue.test.tsx InteractionPanel.test.tsx
```

Expected: FAIL before component updates.

- [ ] **Step 3: Implement inbox and issue detail flow**

- Rename dashboard section to **Needs Input**
- Show pause kind badges (`brainstorm`, `approval`, `decision`)
- Use issue-scoped submit mutation (`POST /issues/{identifier}/input`)
- Keep defer passive and cancel mapped to existing cancel flow

- [ ] **Step 4: Re-run UI tests and build**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm test InteractionQueue.test.tsx InteractionPanel.test.tsx
pnpm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx crates/ensemble-ui/src-ui/src/hooks.ts crates/ensemble-ui/src-ui/src/components/InteractionQueue.test.tsx crates/ensemble-ui/src-ui/src/components/InteractionPanel.test.tsx
git commit -m "Implement Needs Input UI workflow for issue-scoped responses"
```

---

### Task 5: Regenerate API Client and Update Docs/Spec

**Files:**
- Regenerate: `crates/ensemble-ui/src-ui/src/generated/api/**`
- Modify: `docs/SPEC.md`
- Modify: `docs/pipelines.md` (if interaction semantics are described there)

- [ ] **Step 1: Regenerate frontend API client from updated OpenAPI**

Run:

```bash
cd crates/ensemble-ui/src-ui
pnpm run generate:api
```

Expected: generated models/hooks include issue input endpoint + pending input schema.

- [ ] **Step 2: Update spec language for hybrid interaction behavior**

Update `docs/SPEC.md` sections that currently say user-input-required is hard failure:
- replace with issue-scoped waiting behavior
- document indefinite wait semantics and resume API
- clarify internal-only logging for prompt/response

- [ ] **Step 3: Run docs-adjacent and workspace validation**

Run:

```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/generated/api docs/SPEC.md docs/pipelines.md
git commit -m "Update API client and docs for hybrid input workflow"
```

---

### Task 6: Final Regression Pass for Restart Recovery and Idempotency

**Files:**
- Modify/Test: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify/Test: `crates/ensemble-core/src/interaction/store.rs`
- Modify/Test: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Add final regression tests**

Add tests:

```rust
#[tokio::test]
async fn restart_hydrates_pending_input_and_preserves_waiting_issue() {}

#[tokio::test]
async fn duplicate_submit_is_idempotent_or_conflict_without_state_corruption() {}

#[tokio::test]
async fn cancel_while_waiting_clears_pending_input_and_claims() {}
```

- [ ] **Step 2: Run targeted regression tests**

Run:

```bash
cargo test -p ensemble-core restart_hydrates_pending_input -- --nocapture
cargo test -p ensemble-core duplicate_submit -- --nocapture
cargo test -p ensemble-core cancel_while_waiting -- --nocapture
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run:

```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
cd crates/ensemble-ui/src-ui && pnpm test && pnpm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/interaction/store.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "Harden pending input recovery and idempotency"
```

---

## Self-Review Checklist

- Spec coverage: all approved design points are mapped to tasks (state model, API/events, UI inbox, failure handling/testing).
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: pause kinds and lifecycle event names are consistent (`brainstorm_prompt`, `approval_gate`, `manual_decision`; `input_requested/submitted/resumed`).

