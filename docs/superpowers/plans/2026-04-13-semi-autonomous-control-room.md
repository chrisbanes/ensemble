# Semi-Autonomous Control Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Ensemble's existing workflow runner into a semi-autonomous control room by making step execution explicitly wait for human input, surfacing those waits in the web UI, and keeping external trackers optional.

**Architecture:** Reuse the existing interaction/request infrastructure as the runtime foundation for human-in-the-loop execution, but normalize it around ticket-scoped agent asks and question-first UI. Keep workflow policy in `config.yaml`, persist asks/replies in runtime state, and let the orchestrator resume parked step runs on a later tick after a human reply arrives.

**Tech Stack:** Rust 2021, tokio, serde/serde_json, axum, utoipa/OpenAPI, SQLite-backed runtime history/interaction stores, React 19, TanStack Query, Orval-generated API client, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `crates/ensemble-core/src/interaction/model.rs` | Modify | Rename and simplify interaction payloads around agent asks/question-first semantics |
| `crates/ensemble-core/src/interaction/store.rs` | Modify | Persist unresolved asks, replies, and resume-safe guards per ticket/step |
| `crates/ensemble-core/src/orchestrator/state.rs` | Modify | Track `waiting_for_human` state and resume requests in orchestrator memory |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Modify | Park running steps on asks and resume them on later ticks |
| `crates/ensemble-core/src/timeline/model.rs` | Modify | Add timeline events for question asked / reply submitted / step resumed |
| `crates/ensemble-core/src/timeline/writer.rs` | Modify | Persist new human-interaction timeline events |
| `crates/ensemble-core/src/observability/snapshot.rs` | Modify | Expose question-first detail and attention queue projections in runtime snapshots |
| `crates/ensemble-core/src/api/interactions.rs` | Modify | Align interaction detail endpoints with agent-ask model |
| `crates/ensemble-core/src/api/controls.rs` | Modify | Keep issue-scoped submit/resume API behavior authoritative |
| `crates/ensemble-core/src/api/openapi.rs` | Modify | Document the new runtime contract and schemas |
| `crates/ensemble-core/src/tracker/mod.rs` | Modify | Clarify tracker role as optional source/sink, not runtime authority |
| `crates/ensemble-core/src/config/ensemble.rs` | Modify | Keep config focused on workflow policy and optional integration settings |
| `crates/ensemble-core/tests/api_endpoints.rs` | Modify | API coverage for question-first submit flow and conflict cases |
| `crates/ensemble-core/tests/workflow_to_workspace.rs` | Modify | Integration coverage for parked step + resume flow |
| `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx` | Modify | Make control room the primary landing view |
| `crates/ensemble-ui/src-ui/src/components/KanbanBoard.tsx` | Modify | De-emphasize board metaphors and raise “Needs attention” |
| `crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx` | Modify | Render attention queue entries as agent questions |
| `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx` | Modify | Make the top of the page question-first with workflow context beneath |
| `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx` | Modify | Show exact question, why blocked, reply box, and optional context |
| `crates/ensemble-ui/src-ui/src/components/WorkflowStepsSidebar.tsx` | Modify | Keep workflow context visible while a step waits for human input |
| `crates/ensemble-ui/src-ui/src/hooks.ts` | Modify | Invalidate attention queue and issue detail around ask/reply lifecycle |
| `crates/ensemble-ui/src-ui/src/components/InteractionQueue.test.tsx` | Modify | UI coverage for control-room attention ordering and labels |
| `crates/ensemble-ui/src-ui/src/components/InteractionPanel.test.tsx` | Modify | UI coverage for question-first rendering and reply submission |
| `crates/ensemble-ui/src-ui/src/pages/Dashboard.test.tsx` | Create | Dashboard coverage for control-room framing |
| `docs/SPEC.md` | Modify | Update product framing from tracker-first runner to semi-autonomous control room |

---

### Task 1: Normalize the domain model around ticket-scoped agent asks

**Files:**
- Modify: `crates/ensemble-core/src/interaction/model.rs`
- Modify: `crates/ensemble-core/src/interaction/store.rs`
- Test: `crates/ensemble-core/src/interaction/store.rs`

- [ ] **Step 1: Write the failing store tests for question-first ask semantics**

Add tests like:

```rust
#[tokio::test]
async fn create_question_ask_defaults_to_open_waiting_for_human() {}

#[tokio::test]
async fn resolving_an_ask_marks_it_resolved_and_not_awaiting_resume() {}

#[tokio::test]
async fn only_one_unresolved_ask_can_exist_for_a_ticket_step_pair() {}
```

- [ ] **Step 2: Run the interaction-store tests to verify failure**

Run:

```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```

Expected: FAIL because the current interaction model still reflects the older brainstorm/approval/handoff framing.

- [ ] **Step 3: Simplify the interaction model to the MVP ask payload**

Update the model shape so the persisted ask contract is centered on the control-room MVP:

```rust
pub struct AgentAsk {
    pub id: String,
    pub issue_id: String,
    pub issue_identifier: String,
    pub step_name: String,
    pub agent_name: String,
    pub question: String,
    pub why_blocked: String,
    pub suggested_answer: Option<String>,
    pub extra_context: Option<String>,
    pub status: InteractionStatus,
    pub awaiting_resume: bool,
    pub requested_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}
```

Keep serde compatibility where possible so existing persisted interactions can still deserialize.

- [ ] **Step 4: Update the store methods to persist ask/reply semantics**

Refactor store entry points around explicit ask/reply operations, for example:

```rust
pub async fn create_ask(&self, ask: AgentAsk) -> Result<AgentAsk, InteractionError>;
pub async fn reply(&self, id: &str, response: String) -> Result<AgentAsk, InteractionError>;
pub async fn cancel(&self, id: &str) -> Result<AgentAsk, InteractionError>;
```

Preserve the unresolved-ask guard so a step cannot open multiple simultaneous questions.

- [ ] **Step 5: Re-run the interaction-store tests**

Run:

```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/interaction/model.rs crates/ensemble-core/src/interaction/store.rs
git commit -m "Refocus interaction model on agent asks"
```

---

### Task 2: Park and resume workflow steps through explicit human-input runtime states

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/timeline/model.rs`
- Modify: `crates/ensemble-core/src/timeline/writer.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`
- Test: `crates/ensemble-core/tests/workflow_to_workspace.rs`

- [ ] **Step 1: Write failing orchestrator tests for the new step state machine**

Add tests like:

```rust
#[tokio::test]
async fn step_moves_to_waiting_for_human_when_agent_asks_a_question() {}

#[tokio::test]
async fn downstream_steps_do_not_start_while_waiting_for_human() {}

#[tokio::test]
async fn_step_resumes_on_next_tick_after_human_reply_is_persisted() {}
```

- [ ] **Step 2: Run orchestrator tests to verify failure**

Run:

```bash
cargo test -p ensemble-core orchestrator::mod -- --nocapture
cargo test -p ensemble-core --test workflow_to_workspace -- --nocapture
```

Expected: FAIL because step runs are not yet explicitly parked in `waiting_for_human`.

- [ ] **Step 3: Add `waiting_for_human` to the runtime state model**

Introduce an explicit step/runtime state branch similar to:

```rust
pub enum StepRunState {
    Pending,
    Running,
    WaitingOnDependency,
    WaitingForHuman { ask_id: String },
    Paused,
    Completed,
    Failed,
}
```

Keep this runtime-only; do not move workflow policy into the state enum.

- [ ] **Step 4: Emit and persist question/reply lifecycle events**

Add timeline events like:

```rust
QuestionAsked { issue_identifier, step_name, agent_name, ask_id }
HumanReplySubmitted { issue_identifier, step_name, ask_id }
StepResumedFromHumanReply { issue_identifier, step_name, ask_id }
```

Write them through the existing timeline writer as part of the same authoritative orchestrator flow.

- [ ] **Step 5: Implement park/resume behavior in the orchestrator**

Keep the control boundary clean:

```rust
if let Some(ask) = agent_session.pending_ask() {
    state.park_step_waiting_for_human(&issue.id, &step.name, ask.id.clone());
    timeline.write_question_asked(&issue.identifier, &step.name, &ask.id).await?;
    return Ok(StepOutcome::WaitingForHuman);
}
```

On a later tick, if the persisted ask has a reply and is awaiting resume, resume the same step/session rather than advancing the DAG prematurely.

- [ ] **Step 6: Re-run orchestrator and workflow integration tests**

Run:

```bash
cargo test -p ensemble-core orchestrator::mod -- --nocapture
cargo test -p ensemble-core --test workflow_to_workspace -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/state.rs crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/timeline/model.rs crates/ensemble-core/src/timeline/writer.rs crates/ensemble-core/tests/workflow_to_workspace.rs
git commit -m "Add waiting-for-human step runtime state"
```

---

### Task 3: Expose a question-first runtime API and snapshot contract

**Files:**
- Modify: `crates/ensemble-core/src/api/interactions.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Modify: `crates/ensemble-core/src/observability/snapshot.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`

- [ ] **Step 1: Write failing API tests for issue-scoped human replies**

Add tests like:

```rust
#[tokio::test]
async fn post_issue_input_returns_updated_waiting_ticket_snapshot() {}

#[tokio::test]
async fn post_issue_input_conflicts_when_ticket_is_not_waiting_for_human() {}

#[tokio::test]
async fn issue_detail_exposes_question_first_pending_input_summary() {}
```

- [ ] **Step 2: Run the API tests to verify failure**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints issue_input -- --nocapture
```

Expected: FAIL because the older interaction contract is still more generic than the new question-first design.

- [ ] **Step 3: Update the issue snapshot shape to expose the control-room view**

Expose a `pending_input` summary shaped for the UI:

```rust
pub struct PendingInputSummary {
    pub ask_id: String,
    pub question: String,
    pub why_blocked: String,
    pub suggested_answer: Option<String>,
    pub extra_context: Option<String>,
    pub step_name: String,
    pub agent_name: String,
    pub requested_at: DateTime<Utc>,
}
```

Return this from issue-detail and aggregate attention-queue endpoints/snapshots.

- [ ] **Step 4: Keep the issue-scoped reply endpoint authoritative**

Ensure `POST /api/v1/issues/{identifier}/input` writes a reply only when the issue is currently waiting:

```rust
pub struct IssueInputBody {
    pub response: String,
}
```

On success, persist the reply and signal the orchestrator loop; do not perform the resume transition directly inside the API handler.

- [ ] **Step 5: Align the interaction detail endpoint with the same ask vocabulary**

Return the same top-level fields (`question`, `why_blocked`, `suggested_answer`, `extra_context`) from the interaction detail API so the UI does not have to translate old terminology.

- [ ] **Step 6: Re-run the API tests**

Run:

```bash
cargo test -p ensemble-core --test api_endpoints issue_input -- --nocapture
cargo test -p ensemble-core observability::snapshot -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/api/interactions.rs crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/api/openapi.rs crates/ensemble-core/src/observability/snapshot.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "Expose question-first waiting-for-human API"
```

---

### Task 4: Reframe the web app as a control room with a Needs Attention queue

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/KanbanBoard.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionQueue.test.tsx`
- Create: `crates/ensemble-ui/src-ui/src/pages/Dashboard.test.tsx`

- [ ] **Step 1: Add failing dashboard tests for the control-room framing**

Create tests like:

```tsx
it("renders a Needs attention section ahead of normal execution buckets", () => {});
it("shows waiting tickets as question-first queue items", () => {});
```

- [ ] **Step 2: Run the dashboard and queue tests to verify failure**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/InteractionQueue.test.tsx src/pages/Dashboard.test.tsx
```

Expected: FAIL because the dashboard still renders primarily as a kanban board.

- [ ] **Step 3: Update the dashboard title and structure to control-room language**

Adjust the page header and section order so the primary screen reads more like:

```tsx
<h1 className="text-2xl font-bold">Control Room</h1>
```

Put `Needs attention` above routine running/completed views.

- [ ] **Step 4: Update the queue item copy to show the actual question first**

Make each queue row emphasize the ticket and its current question, for example:

```tsx
<div>
  <p className="font-medium">{ticket.issue_identifier}</p>
  <p className="text-sm text-muted-foreground">{pendingInput.question}</p>
</div>
```

De-emphasize generic interaction labels like “brainstorm prompt” in the control room list.

- [ ] **Step 5: Re-run the dashboard and queue tests**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/InteractionQueue.test.tsx src/pages/Dashboard.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx crates/ensemble-ui/src-ui/src/components/KanbanBoard.tsx crates/ensemble-ui/src-ui/src/components/InteractionQueue.tsx crates/ensemble-ui/src-ui/src/components/InteractionQueue.test.tsx crates/ensemble-ui/src-ui/src/pages/Dashboard.test.tsx
git commit -m "Reframe dashboard as control room"
```

---

### Task 5: Make ticket detail question-first while preserving workflow context

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/WorkflowStepsSidebar.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Modify: `crates/ensemble-ui/src-ui/src/components/InteractionPanel.test.tsx`

- [ ] **Step 1: Add failing tests for the question-first detail panel**

Add tests like:

```tsx
it("renders the exact agent question as the primary heading", () => {});
it("shows why the agent is blocked above the reply box", () => {});
it("keeps workflow step context visible while waiting for input", () => {});
```

- [ ] **Step 2: Run the interaction-panel tests to verify failure**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/InteractionPanel.test.tsx
```

Expected: FAIL because the current panel still uses generic interaction titles/body copy.

- [ ] **Step 3: Update `InteractionPanel` to use the new question-first contract**

Reshape the component around:

```tsx
<h2 className="text-lg font-semibold">{interaction.question}</h2>
<p className="text-sm text-muted-foreground">{interaction.why_blocked}</p>
<Textarea placeholder="Answer the agent's question" />
```

Render `suggested_answer` and `extra_context` in secondary UI blocks only when present.

- [ ] **Step 4: Update `IssueDetail` to place the ask above transcript/logs**

Keep the current workflow sidebar and timeline/conversation, but ensure the human sees the active question first when a ticket is waiting for input.

- [ ] **Step 5: Invalidate the right queries after reply submission**

Confirm `useIssueInputMutation` invalidates:

```ts
getGetStateQueryKey()
getGetIssueDetailQueryKey(identifier)
getListOpenInteractionsQueryKey()
```

so the control room and ticket detail update together.

- [ ] **Step 6: Re-run the interaction-panel tests**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/InteractionPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx crates/ensemble-ui/src-ui/src/components/InteractionPanel.tsx crates/ensemble-ui/src-ui/src/components/WorkflowStepsSidebar.tsx crates/ensemble-ui/src-ui/src/hooks.ts crates/ensemble-ui/src-ui/src/components/InteractionPanel.test.tsx
git commit -m "Make waiting ticket detail question-first"
```

---

### Task 6: Update docs and integration framing to match the new runtime authority model

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `crates/ensemble-core/src/tracker/mod.rs`
- Modify: `crates/ensemble-core/src/config/ensemble.rs`

- [ ] **Step 1: Write a small failing docs/spec checklist in the plan notes**

Check that the updated docs cover:

```text
- Tickets remain canonical work items
- External trackers are optional sources/sinks
- Workflow policy stays in config.yaml
- Runtime authority lives in Ensemble state
```

- [ ] **Step 2: Update `docs/SPEC.md` product framing**

Replace tracker-first framing with text along the lines of:

```md
Ensemble runs agent workflows for tickets and provides a control room for supervising interactive execution.
External trackers may provide tickets, but Ensemble owns live execution state.
```

- [ ] **Step 3: Update inline tracker/config module docs**

Clarify in the relevant Rust modules that trackers are integration adapters and `config.yaml` remains a policy layer rather than a runtime collaboration log.

- [ ] **Step 4: Run formatting and targeted tests**

Run:

```bash
cargo fmt --all
cargo test -p ensemble-core interaction::store orchestrator::mod -- --nocapture
cd crates/ensemble-ui/src-ui && pnpm vitest run src/components/InteractionQueue.test.tsx src/components/InteractionPanel.test.tsx src/pages/Dashboard.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md crates/ensemble-core/src/tracker/mod.rs crates/ensemble-core/src/config/ensemble.rs
git commit -m "Document semi-autonomous control-room architecture"
```

---

## Self-Review

### Spec coverage
- Workflow backbone preserved: Tasks 1, 2, and 6
- Interactive runtime state and resume semantics: Tasks 1, 2, and 3
- Control-room primary UI: Tasks 4 and 5
- Question-first ticket detail: Task 5
- Tickets as canonical work items and trackers as optional: Tasks 3 and 6
- Config vs runtime boundary: Tasks 1, 3, and 6
- MVP simplicity / explicit asks only: Tasks 1 through 5

### Placeholder scan
- No `TBD`, `TODO`, or deferred implementation markers remain in tasks.
- Each task lists concrete files and concrete commands.
- Each testing step names exact commands and expected outcomes.

### Type consistency
- The plan consistently uses `Ticket`, `WorkflowRun`, `StepRun`, `AgentAsk`, and `HumanReply` vocabulary.
- The MVP ask payload is consistently `question`, `why_blocked`, `suggested_answer`, and `extra_context`.
- The runtime state consistently uses `waiting_for_human`.
