# Threaded Interaction Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, thread-scoped slash-command handling for human interaction requests, while keeping Ensemble state as the source of truth and adding automatic interaction-policy prompt injection.

**Architecture:** Extend the existing interaction subsystem with tracker-thread metadata + command audit records, add tracker adapter methods for interaction-thread IO, and process thread replies in the orchestrator tick loop using strict v1 rules (thread-only, slash-only, original-text-only, first-valid-command-wins). Prompt policy injection is implemented in agent prompt assembly as a default-on runtime concern with config override support.

**Tech Stack:** Rust 2021, tokio, serde/serde_json/serde_yaml, tracing, axum/OpenAPI, existing Ensemble tracker + orchestrator modules

---

## File Structure

### Modified Files

| File | Responsibility |
|---|---|
| `crates/ensemble-core/src/interaction/model.rs` | Add thread metadata and command audit fields to `InteractionRequest` |
| `crates/ensemble-core/src/interaction/store.rs` | Persist/read new metadata and append accepted/ignored command events atomically |
| `crates/ensemble-core/src/interaction/error.rs` | Add errors for invalid command/state transitions |
| `crates/ensemble-core/src/tracker/mod.rs` | Extend tracker trait with interaction-thread helpers (create thread, list new replies) |
| `crates/ensemble-core/src/tracker/github.rs` | Implement GitHub adapter for root comment creation and comment polling/parsing |
| `crates/ensemble-core/src/tracker/todo_file.rs` | Return explicit unsupported behavior for thread command operations |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Create interaction threads on block + resolve from thread commands during ticks |
| `crates/ensemble-core/src/orchestrator/state.rs` | Track per-issue interaction-thread polling cursor/checkpoint |
| `crates/ensemble-core/src/config/ensemble.rs` | Add interaction command policy config + prompt policy injection config |
| `crates/ensemble-core/src/agent/mod.rs` | Inject interaction policy block into runtime prompt assembly |
| `crates/ensemble-core/src/api/interactions.rs` | Expose thread metadata and accepted command audit in interaction responses |
| `crates/ensemble-core/src/api/openapi.rs` | Register new config/interaction schema updates |
| `docs/SPEC.md` | Document v1 threaded command semantics and deterministic resolution rules |
| `docs/configuration.md` | Document new interaction command + prompt-injection config settings |
| `docs/pipelines.md` | Document expected agent behavior for batched clarification requests |
| `README.md` | Add concise mention of threaded interaction command workflow |

### New Files

| File | Responsibility |
|---|---|
| `crates/ensemble-core/src/interaction/commands.rs` | Slash-command parser + validation (`/approve`, `/reject`, `/answer`) |
| `crates/ensemble-core/src/tracker/model.rs` (or existing tracker model file extension) | Typed tracker comment event structs for thread replies |

---

### Task 1: Extend interaction model + store for thread metadata and command audit (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/interaction/model.rs`
- Modify: `crates/ensemble-core/src/interaction/store.rs`
- Modify: `crates/ensemble-core/src/interaction/error.rs`
- Test: `crates/ensemble-core/src/interaction/store.rs`

- [ ] **Step 1: Add failing tests for thread metadata round-trip and command audit append**

Add tests covering:
- persisted `thread_root_comment_id` round-trip
- accepted command is written once and locks request
- later commands are recorded as ignored

- [ ] **Step 2: Run tests and verify failures**

Run:
```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```
Expected: FAIL on missing fields/methods.

- [ ] **Step 3: Implement model extensions**

Add fields to `InteractionRequest` (or nested struct):
- tracker thread linkage (e.g., `thread_root_comment_id`, `thread_channel`)
- accepted command record (author, timestamp, original body, parsed action)
- ignored command records (same envelope + ignore reason)

- [ ] **Step 4: Implement store helpers**

Add store methods to:
- attach thread metadata after root comment creation
- atomically accept first valid command only
- append ignored command audit records

- [ ] **Step 5: Re-run tests**

Run:
```bash
cargo test -p ensemble-core interaction::store -- --nocapture
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/interaction/model.rs crates/ensemble-core/src/interaction/store.rs crates/ensemble-core/src/interaction/error.rs
git commit -m "Add interaction thread metadata and command audit persistence"
```

---

### Task 2: Add slash-command parser module with strict v1 semantics (TDD)

**Files:**
- Create: `crates/ensemble-core/src/interaction/commands.rs`
- Modify: `crates/ensemble-core/src/interaction/mod.rs`
- Test: `crates/ensemble-core/src/interaction/commands.rs`

- [ ] **Step 1: Add failing parser tests**

Cover:
- valid `/approve`
- valid `/reject <reason>`
- valid `/answer <text>`
- invalid commands
- whitespace/case handling policy

- [ ] **Step 2: Run targeted tests and verify failure**

Run:
```bash
cargo test -p ensemble-core interaction::commands -- --nocapture
```
Expected: FAIL (module missing).

- [ ] **Step 3: Implement parser + command enum**

Implement:
- `InteractionCommand` enum
- parse from original comment body only
- parse errors with explicit reason codes for audit logging

- [ ] **Step 4: Re-run tests**

Run:
```bash
cargo test -p ensemble-core interaction::commands -- --nocapture
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/interaction/commands.rs crates/ensemble-core/src/interaction/mod.rs
git commit -m "Add strict interaction slash command parser"
```

---

### Task 3: Extend tracker trait and GitHub adapter for interaction-thread IO (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/tracker/mod.rs`
- Modify: `crates/ensemble-core/src/tracker/github.rs`
- Modify: `crates/ensemble-core/src/tracker/todo_file.rs`
- Modify/Create: `crates/ensemble-core/src/tracker/model.rs`
- Test: `crates/ensemble-core/src/tracker/github.rs`

- [ ] **Step 1: Add trait methods and failing adapter tests**

Add trait methods for:
- creating a root interaction comment
- listing new thread replies since cursor/checkpoint

Add wiremock-based failing tests for:
- root comment creation response mapping
- comment polling mapping + ordering

- [ ] **Step 2: Run tracker tests and verify failures**

Run:
```bash
cargo test -p ensemble-core tracker::github -- --nocapture
```
Expected: FAIL (new methods unimplemented).

- [ ] **Step 3: Implement GitHub adapter behavior**

Implement:
- root comment body posting with hidden interaction id marker
- polling issue comments, filtering to thread scope marker/rules
- stable ordering by creation timestamp/id

- [ ] **Step 4: Implement todo_file fallback behavior**

Return `TrackerError::WritesNotSupported` (or explicit unsupported variant) for thread command operations.

- [ ] **Step 5: Re-run tests**

Run:
```bash
cargo test -p ensemble-core tracker::github -- --nocapture
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/tracker/mod.rs crates/ensemble-core/src/tracker/github.rs crates/ensemble-core/src/tracker/todo_file.rs crates/ensemble-core/src/tracker/model.rs
git commit -m "Add tracker interaction thread APIs and GitHub implementation"
```

---

### Task 4: Add orchestrator thread lifecycle + deterministic command resolution (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Add failing orchestrator tests**

Cover:
- blocked interaction creates root thread comment and stores thread metadata
- only thread-scoped replies are considered
- only original body text is parsed
- first valid command resolves interaction; later commands ignored

- [ ] **Step 2: Run targeted orchestrator tests and verify failures**

Run:
```bash
cargo test -p ensemble-core orchestrator::tests::blocked -- --nocapture
```
Expected: FAIL (logic not yet present).

- [ ] **Step 3: Implement thread creation on block**

In blocked-on-human path:
- create root tracker comment via new adapter method
- persist thread root metadata in interaction record

- [ ] **Step 4: Implement periodic command ingestion during ticks**

For waiting interactions:
- fetch new replies from tracker adapter
- parse with strict slash parser
- resolve interaction on first valid command
- audit ignored commands (invalid/later/edited/non-thread/etc.)

- [ ] **Step 5: Implement first-valid-command lock semantics**

Ensure store-level and orchestrator-level checks prevent last-write-wins behavior under concurrency.

- [ ] **Step 6: Re-run tests**

Run:
```bash
cargo test -p ensemble-core orchestrator -- --nocapture
```
Expected: PASS for updated interaction/orchestrator tests.

- [ ] **Step 7: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/orchestrator/state.rs
git commit -m "Handle interaction thread commands in orchestrator with first-command lock"
```

---

### Task 5: Add automatic interaction-policy prompt injection (soft batching preference) (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/config/ensemble.rs`
- Modify: `crates/ensemble-core/src/agent/mod.rs`
- Test: `crates/ensemble-core/src/config/ensemble.rs`
- Test: `crates/ensemble-core/src/agent/mod.rs`

- [ ] **Step 1: Add failing config + prompt assembly tests**

Cover:
- default policy injection enabled
- injected policy contains soft batching language
- per-agent/per-step override (`inherit/custom/off`) behavior

- [ ] **Step 2: Run tests and verify failure**

Run:
```bash
cargo test -p ensemble-core agent::tests config::ensemble -- --nocapture
```
Expected: FAIL (config and assembly paths missing fields/logic).

- [ ] **Step 3: Implement config + injection logic**

Add config fields for:
- interaction policy injection toggle
- optional custom policy text
- override mode

Inject policy block during prompt assembly for all agent runs by default.

- [ ] **Step 4: Re-run tests**

Run:
```bash
cargo test -p ensemble-core agent::tests config::ensemble -- --nocapture
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/config/ensemble.rs crates/ensemble-core/src/agent/mod.rs
git commit -m "Inject default interaction policy with soft batching guidance"
```

---

### Task 6: Surface new interaction metadata via API/OpenAPI (TDD)

**Files:**
- Modify: `crates/ensemble-core/src/api/interactions.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`
- Test: `crates/ensemble-core/src/api/interactions.rs`

- [ ] **Step 1: Add failing API tests for thread + command audit fields**

Cover:
- list/get interaction endpoints include thread root metadata
- resolved interactions include accepted command metadata

- [ ] **Step 2: Run API tests and verify failure**

Run:
```bash
cargo test -p ensemble-core api::interactions -- --nocapture
```
Expected: FAIL (schema/serialization mismatch).

- [ ] **Step 3: Update response schema + handlers**

Expose additive fields without breaking existing clients.

- [ ] **Step 4: Re-run API/OpenAPI tests**

Run:
```bash
cargo test -p ensemble-core api::interactions test_openapi_spec_generates -- --nocapture
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/interactions.rs crates/ensemble-core/src/api/openapi.rs
git commit -m "Expose interaction thread and command audit metadata via API"
```

---

### Task 7: Documentation updates (required)

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`
- Modify: `docs/pipelines.md`
- Modify: `README.md`

- [ ] **Step 1: Update SPEC with v1 command semantics**

Document:
- thread-only command intake
- slash-only command grammar
- original-text-only parsing
- first-valid-command-wins lock
- no auto-expiry + reminder-only behavior

- [ ] **Step 2: Update configuration docs**

Document new config keys for:
- interaction command behavior toggles (where applicable)
- prompt policy injection defaults + override modes

- [ ] **Step 3: Update pipeline guidance**

Document agent behavior expectations:
- soft preference for batched questions
- required question structure (question, why, default)

- [ ] **Step 4: Update README summary**

Add concise overview of threaded interaction workflow for operators.

- [ ] **Step 5: Run docs consistency checks**

Run:
```bash
cargo fmt --all -- --check
```
Expected: PASS (no Rust formatting regressions from examples/snippets in rustdoc comments).

- [ ] **Step 6: Commit**

```bash
git add docs/SPEC.md docs/configuration.md docs/pipelines.md README.md
git commit -m "Document threaded interaction commands and prompt policy injection"
```

---

### Task 8: End-to-end verification + cleanup

**Files:**
- Modify as needed based on test fixes

- [ ] **Step 1: Run focused core tests**

Run:
```bash
cargo test -p ensemble-core interaction::commands interaction::store orchestrator::tests::blocked tracker::github api::interactions -- --nocapture
```
Expected: PASS.

- [ ] **Step 2: Run workspace verification**

Run:
```bash
cargo test --workspace --exclude ensemble-desktop
cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
cargo fmt --all -- --check
```
Expected: PASS.

- [ ] **Step 3: Final commit (if needed)**

```bash
git add -A
git commit -m "Finalize threaded interaction command support"
```

---

## Spec Coverage Check

- Thread-based interaction UX + strict command semantics: covered in Tasks 1, 2, 3, 4.
- Deterministic first-valid-command resolution + auditability: covered in Tasks 1 and 4.
- Automatic prompt policy injection + soft batching preference: covered in Task 5.
- API visibility: covered in Task 6.
- Documentation updates: covered in Task 7.

No spec gaps identified for the scoped v1 feature.

