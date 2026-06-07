# Decouple Timeline Persistence from Orchestrator Hot Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move timeline file persistence from the orchestrator's inline await to a background task, keeping the event bus publish immediate and preserving per-run ordering.

**Architecture:** A `TimelinePersistence` actor owns a background `tokio::spawn` task that drains an unbounded `mpsc` channel and writes events sequentially via `TimelineWriter`. The orchestrator sends events to the channel and returns immediately.

**Tech Stack:** Rust, tokio, serde_json, tracing, tempfile (tests)

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `crates/ensemble-core/src/timeline/persistence.rs` | New actor: channel sender + background task + flush | Create |
| `crates/ensemble-core/src/timeline/mod.rs` | Re-export `persistence` module | Modify |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Replace `timeline_writer` field with `timeline_persistence`, update `publish_pipeline_event`, add shutdown flush | Modify |

---

### Task 1: Create `TimelinePersistence` Actor with Tests

**Files:**
- Create: `crates/ensemble-core/src/timeline/persistence.rs`
- Modify: `crates/ensemble-core/src/timeline/mod.rs`

**Prerequisite:** Read the existing `TimelineWriter` and `TimelineEventRecord` to understand the interface.

```bash
# Read existing files
rtk Read file: /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo/crates/ensemble-core/src/timeline/writer.rs
rtk Read file: /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo/crates/ensemble-core/src/timeline/model.rs
```

---

- [ ] **Step 1: Write failing tests for `TimelinePersistence`**

Create `crates/ensemble-core/src/timeline/persistence.rs` with a test module first (TDD). The implementation struct and methods don't exist yet — tests will fail to compile.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use tempfile::TempDir;
    use tokio::time::{sleep, Duration};

    fn sample_event(run_id: &str, sequence: u64) -> TimelineEventRecord {
        TimelineEventRecord {
            run_id: run_id.to_string(),
            issue_identifier: "repo#1".to_string(),
            sequence,
            timestamp: Utc::now(),
            event_type: "step_started".to_string(),
            step_name: Some("build".to_string()),
            attempt: 1,
            detail: "started build".to_string(),
            verdict: None,
            tool_name: None,
        }
    }

    #[tokio::test]
    async fn send_creates_file_and_writes_event() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        persistence.send("run-1".to_string(), record.clone());
        // Give background task time to write
        sleep(Duration::from_millis(50)).await;

        let path = temp_dir.path().join(".ensemble").join("runs").join("run-1").join("events.jsonl");
        assert!(path.exists());
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        assert_eq!(contents.lines().count(), 1);
        let parsed: TimelineEventRecord = serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(parsed.run_id, "run-1");
        assert_eq!(parsed.sequence, 1);
    }

    #[tokio::test]
    async fn ordering_preserved_across_multiple_events() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());

        for i in 1..=10 {
            persistence.send("run-1".to_string(), sample_event("run-1", i));
        }
        sleep(Duration::from_millis(50)).await;

        let path = temp_dir.path().join(".ensemble").join("runs").join("run-1").join("events.jsonl");
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 10);
        for (i, line) in lines.iter().enumerate() {
            let parsed: TimelineEventRecord = serde_json::from_str(line).unwrap();
            assert_eq!(parsed.sequence, (i + 1) as u64);
        }
    }

    #[tokio::test]
    async fn send_returns_immediately() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        let start = std::time::Instant::now();
        persistence.send("run-1".to_string(), record);
        let elapsed = start.elapsed();
        // Should return in less than 1ms (no file I/O on this thread)
        assert!(elapsed < Duration::from_millis(1), "send() took too long: {:?}", elapsed);
    }

    #[tokio::test]
    async fn flush_waits_for_pending_events() {
        let temp_dir = TempDir::new().unwrap();
        let persistence = TimelinePersistence::new(temp_dir.path().to_path_buf());
        let record = sample_event("run-1", 1);

        persistence.send("run-1".to_string(), record);
        persistence.flush().await;

        let path = temp_dir.path().join(".ensemble").join("runs").join("run-1").join("events.jsonl");
        assert!(path.exists());
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        assert_eq!(contents.lines().count(), 1);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail (compile error)**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk cargo test -p ensemble-core timeline::persistence
```

**Expected:** Compile error — `TimelinePersistence` not found.

---

- [ ] **Step 3: Implement `TimelinePersistence`**

Add the implementation above the test module in the same file:

```rust
use std::path::PathBuf;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::timeline::model::TimelineEventRecord;
use crate::timeline::writer::TimelineWriter;

#[derive(Debug)]
struct PersistRequest {
    run_id: String,
    record: TimelineEventRecord,
}

pub struct TimelinePersistence {
    sender: mpsc::UnboundedSender<PersistRequest>,
    handle: Option<JoinHandle<()>>,
}

impl TimelinePersistence {
    pub fn new(workspace_root: PathBuf) -> Self {
        let writer = TimelineWriter::new(workspace_root);
        let (sender, mut receiver) = mpsc::unbounded_channel::<PersistRequest>();

        let handle = tokio::spawn(async move {
            while let Some(req) = receiver.recv().await {
                if let Err(error) = writer.append(&req.run_id, &req.record).await {
                    warn!(
                        event = "timeline_persist_failed",
                        run_id = %req.run_id,
                        error = %error,
                        "failed to persist timeline event"
                    );
                }
            }
        });

        Self {
            sender,
            handle: Some(handle),
        }
    }

    /// Send a timeline event to the background persistence task.
    /// Non-blocking; returns immediately.
    pub fn send(&self, run_id: String, record: TimelineEventRecord) {
        if let Err(_) = self.sender.send(PersistRequest { run_id, record }) {
            warn!("timeline persist channel closed; event dropped");
        }
    }

    /// Flush all pending events and wait for the background task to finish.
    /// Call this on shutdown.
    pub async fn flush(mut self) {
        drop(self.sender); // close the channel
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}
```

- [ ] **Step 4: Register the module in `timeline/mod.rs`**

```rust
pub mod model;
pub mod persistence;
pub mod reader;
pub mod writer;
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk cargo test -p ensemble-core timeline::persistence
```

**Expected:** All 4 tests pass.

- [ ] **Step 6: Commit**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git add crates/ensemble-core/src/timeline/persistence.rs crates/ensemble-core/src/timeline/mod.rs
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git commit -m "feat(timeline): add TimelinePersistence background actor"
```

---

### Task 2: Wire `TimelinePersistence` into the Orchestrator

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

**Prerequisite:** Read the current `Orchestrator` struct and `publish_pipeline_event` to understand the exact lines to change.

```bash
rtk Read file: /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo/crates/ensemble-core/src/orchestrator/mod.rs offset:87 limit:20
rtk Read file: /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo/crates/ensemble-core/src/orchestrator/mod.rs offset:159 limit:40
rtk Read file: /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo/crates/ensemble-core/src/orchestrator/mod.rs offset:3461 limit:40
```

---

- [ ] **Step 1: Replace `timeline_writer` field with `timeline_persistence`**

In `Orchestrator` struct (~line 100):

```rust
// OLD:
    timeline_writer: TimelineWriter,

// NEW:
    timeline_persistence: TimelinePersistence,
```

- [ ] **Step 2: Update import statement**

At the top of the file, replace the `TimelineWriter` import with `TimelinePersistence`:

```rust
// OLD:
use crate::timeline::writer::TimelineWriter;

// NEW:
use crate::timeline::persistence::TimelinePersistence;
```

- [ ] **Step 3: Update `new_with_state` constructor**

In `new_with_state` (~line 189):

```rust
// OLD:
            timeline_writer: TimelineWriter::new(parts.workspace_root),

// NEW:
            timeline_persistence: TimelinePersistence::new(parts.workspace_root),
```

- [ ] **Step 4: Update `publish_pipeline_event` to use `send()`**

```rust
    async fn publish_pipeline_event(
        &self,
        run_id: Option<String>,
        sequence: Option<u64>,
        attempt: u32,
        event: PipelineEvent,
    ) {
        let timeline_entry = if let (Some(run_id), Some(sequence)) = (run_id, sequence) {
            Some((
                run_id.clone(),
                event.to_timeline_record(&run_id, sequence, attempt),
            ))
        } else {
            None
        };

        self.event_bus.publish(event);

        if let Some((run_id, record)) = timeline_entry {
            self.timeline_persistence.send(run_id, record);
        }
    }
```

- [ ] **Step 5: Add shutdown flush in `run()`**

In the `run()` method, after the main loop exits (~line 301):

```rust
        info!("orchestrator stopped, flushing timeline persistence");
        self.timeline_persistence.flush().await;
        info!("timeline persistence flushed");

        info!("orchestrator stopped");
```

Note: `flush()` takes `self` by value, but `run()` takes `&mut self`. We need to use `std::mem::take` or restructure. Since `TimelinePersistence` is not `Clone`, we can wrap it in an `Option` and `take()` it:

```rust
// In struct:
    timeline_persistence: Option<TimelinePersistence>,

// In new_with_state:
    timeline_persistence: Some(TimelinePersistence::new(parts.workspace_root)),

// In publish_pipeline_event:
    if let Some(ref persistence) = self.timeline_persistence {
        persistence.send(run_id, record);
    }

// In run() shutdown:
    if let Some(persistence) = self.timeline_persistence.take() {
        persistence.flush().await;
    }
```

- [ ] **Step 6: Run compilation to verify no errors**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk cargo check -p ensemble-core
```

**Expected:** Clean compile (no errors, no warnings).

- [ ] **Step 7: Commit**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git add crates/ensemble-core/src/orchestrator/mod.rs
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git commit -m "feat(orchestrator): decouple timeline persistence to background task"
```

---

### Task 3: Fix Existing Orchestrator Tests

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs` (test module)

**Prerequisite:** Read the existing tests that check file existence after `publish_pipeline_event`.

```bash
rtk Read file: /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo/crates/ensemble-core/src/orchestrator/mod.rs offset:7309 limit:180
```

---

- [ ] **Step 1: Fix `publish_pipeline_event_persists_and_broadcasts_with_run_context`**

This test currently awaits `publish_pipeline_event` and then immediately checks the file. With decoupled persistence, the file may not exist yet. We need to add a small sleep or use `flush()`. Since `flush()` consumes `self`, we need to access it differently in tests.

The test creates an `Orchestrator` and checks `orchestrator.timeline_writer.events_path()`. We need to change this to `timeline_persistence` (which is now `Option<TimelinePersistence>`). But `TimelinePersistence` doesn't expose the path. The simplest fix is to add a small sleep.

```rust
    #[tokio::test]
    async fn publish_pipeline_event_persists_and_broadcasts_with_run_context() {
        // ... existing setup ...
        let mut rx = orchestrator.event_bus.subscribe();

        orchestrator
            .publish_pipeline_event(
                Some("run-1".into()),
                Some(11),
                3,
                PipelineEvent::Output {
                    issue_identifier: "repo#1".into(),
                    timestamp: Utc::now(),
                    step_name: "build".into(),
                    detail: "streamed output".into(),
                },
            )
            .await;

        let received = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event should be published")
            .expect("receiver should get event");
        assert_eq!(received.issue_identifier(), "repo#1");

        // Wait for background persistence task to write
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Use TimelineWriter directly to check the path (or construct the path manually)
        let path = temp_dir.path().join(".ensemble").join("runs").join("run-1").join("events.jsonl");
        assert!(path.exists());
        let contents = tokio::fs::read_to_string(path).await.unwrap();
        let record: crate::timeline::model::TimelineEventRecord =
            serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(record.sequence, 11);
        assert_eq!(record.attempt, 3);
        assert_eq!(record.event_type, "output");
        assert_eq!(record.step_name.as_deref(), Some("build"));
    }
```

- [ ] **Step 2: Fix `publish_pipeline_event_still_broadcasts_when_timeline_write_fails`**

This test creates a `timeline_writer` by writing a file at `.ensemble` to block directory creation. The test checks `orchestrator.timeline_writer.events_path()`. We need to change this to construct the path manually since `timeline_writer` is no longer accessible.

```rust
    #[tokio::test]
    async fn publish_pipeline_event_still_broadcasts_when_timeline_write_fails() {
        // ... existing setup ...
        std::fs::write(dir.path().join(".ensemble"), "blocked").unwrap();
        // ... create orchestrator ...
        let mut rx = orchestrator.event_bus.subscribe();

        orchestrator
            .publish_pipeline_event(
                Some("run-1".into()),
                Some(1),
                2,
                // ... event ...
            )
            .await;

        let received = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event should be published despite persist failure")
            .expect("receiver should get event");
        assert_eq!(received.issue_identifier(), "repo#1");

        // Construct path manually
        let path = dir.path().join(".ensemble").join("runs").join("run-1").join("events.jsonl");
        assert!(!path.exists());
    }
```

- [ ] **Step 3: Fix `question_asked_timeline_event_is_emitted_when_step_blocks_on_human`**

This test also checks `orchestrator.timeline_writer.events_path()`. Change to manual path construction.

```rust
        let events_path = dir.path().join(".ensemble").join("runs").join(&run_id).join("events.jsonl");
```

- [ ] **Step 4: Run the affected tests**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk cargo test -p ensemble-core publish_pipeline_event
```

**Expected:** All tests pass.

- [ ] **Step 5: Commit**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git add crates/ensemble-core/src/orchestrator/mod.rs
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git commit -m "test(orchestrator): update tests for async timeline persistence"
```

---

### Task 4: Full Verification

- [ ] **Step 1: Run the full `ensemble-core` test suite**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk cargo test -p ensemble-core -- --test-threads=1
```

**Expected:** All tests pass.

- [ ] **Step 2: Run clippy**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk cargo clippy -p ensemble-core -- -D warnings
```

**Expected:** Clean (no warnings).

- [ ] **Step 3: Run formatter check**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk cargo fmt -- --check
```

**Expected:** Clean (no formatting issues).

- [ ] **Step 4: Final commit**

```bash
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git add -A
rtk cd /Users/chris/.paseo/worktrees/0mixpvkw/moonlit-dingo && rtk git commit -m "feat: decouple timeline persistence from orchestrator hot path (#68)"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| Spec Requirement | Plan Task |
|---|---|
| Event bus publication remains immediate | Task 2, Step 4 (still calls `self.event_bus.publish(event)` first) |
| Timeline persistence decoupled from hot path | Task 2, Step 4 (uses `send()` instead of `await append()`) |
| Preserve per-run ordering | Task 1, Step 3 (FIFO channel + sequential background task) |
| Persistence failures logged and non-fatal | Task 1, Step 3 (warn! in background task, warn! on closed channel) |
| Tests for ordering and failure handling | Task 1, Steps 1 & 3 (4 tests covering ordering, flush, immediacy) |
| Shutdown flush | Task 2, Step 5 (flush() in run() after main loop) |

### 2. Placeholder Scan

- No "TBD", "TODO", "implement later", "fill in details" found.
- No vague "add appropriate error handling" — concrete warn! logs specified.
- No "write tests for the above" — all test code is present.
- No "similar to Task N" — each task is self-contained.
- All steps contain actual code or exact commands.

### 3. Type Consistency

- `TimelinePersistence` struct uses `mpsc::UnboundedSender<PersistRequest>` and `Option<JoinHandle<()>>` consistently.
- `send()` signature: `send(&self, run_id: String, record: TimelineEventRecord)` — matches usage in `publish_pipeline_event`.
- `flush()` signature: `async fn flush(mut self)` — matches the `Option::take()` pattern in `run()`.
- `TimelineWriter` is unchanged — its interface is still `append(&self, run_id: &str, record: &TimelineEventRecord)`.

### 4. Scope Check

The plan is focused: one new file, one module registration, one file modification, test fixes. No unrelated refactoring.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-07-decouple-timeline-persistence.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
