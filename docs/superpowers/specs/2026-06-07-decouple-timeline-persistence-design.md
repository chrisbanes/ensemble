# Decouple Timeline Persistence from Orchestrator Hot Path

**Date:** 2026-06-07
**Issue:** [#68](https://github.com/chrisbanes/ensemble/issues/68)
**Status:** Design

## Context

Timeline persistence in `publish_pipeline_event()` is best-effort, but still performed inline with an awaited file append. The orchestrator's event handling loop (`run()`) calls `publish_pipeline_event` synchronously, which means the loop blocks until the file write (create directory, open file, write, flush) completes. Under slow or contended disk I/O, this adds latency and backpressure to the hot path.

## Problem

The current `publish_pipeline_event` implementation:

1. Builds the `TimelineEventRecord` (cheap, CPU only).
2. Publishes to `EventBus` (immediate, non-blocking).
3. **Awaits** `timeline_writer.append()` (file I/O — potentially slow).

Step 3 is the bottleneck. It runs on the same async task as the orchestrator's main loop. The event loop in `run()` is single-threaded — it processes one `worker_rx` event at a time via `tokio::select!`. Every time a worker event arrives, the orchestrator handles it, and if it calls `publish_pipeline_event`, the entire loop pauses until the file write completes.

## Goal

Move timeline persistence to an asynchronous background write path that keeps event handling responsive while preserving per-run event ordering.

## Non-Goals

- **Changing the event bus behavior.** The event bus publish remains immediate and non-blocking.
- **Changing the timeline format.** The JSONL file format is unchanged.
- **Changing the SQLite history store.** The history store (`append_history_record`) is already decoupled from `publish_pipeline_event` and is out of scope.
- **Batching or coalescing writes.** A simple sequential background writer is sufficient. Batching adds complexity without clear benefit for this workload.

## Architecture

Introduce a `TimelinePersistence` actor that owns a background task. The orchestrator sends events to this actor via an unbounded `mpsc` channel and returns immediately. The background task drains the channel FIFO and writes events sequentially using the existing `TimelineWriter`.

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Orchestrator   │     │  TimelinePersistence │     │  TimelineWriter  │
│   (main loop)   │────▶│  (background task)   │────▶│  (file I/O)      │
└─────────────────┘     └─────────────────────┘     └─────────────────┘
         │                        │
         │ (unbounded mpsc)       │ (sequential writes)
         ▼                        ▼
   EventBus.publish()         File append
   (immediate)               (async, off hot path)
```

## Detailed Design

### 1. TimelinePersistence Actor

New file: `crates/ensemble-core/src/timeline/persistence.rs`

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

#### Ordering Guarantee

The orchestrator's `run()` loop is single-threaded with respect to event handling. It processes `worker_rx` events one at a time. `publish_pipeline_event` is only called from this loop. Therefore, events for a given run are sent to the channel in strict sequence. The channel is FIFO, and the background task processes messages in receive order, so writes are also in sequence.

### 2. Orchestrator Changes

Modify `crates/ensemble-core/src/orchestrator/mod.rs`:

1. **Replace `timeline_writer` field** with `timeline_persistence: TimelinePersistence`.
2. **Update `new_with_state`** to construct `TimelinePersistence` instead of `TimelineWriter`.
3. **Update `publish_pipeline_event`** to use `send()` instead of `await append()`:

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

4. **Shutdown hook:** After the main loop exits, call `timeline_persistence.flush()` before returning from `run()`. This ensures all pending events are written before the process exits.

### 3. Shutdown Behavior

```rust
// In Orchestrator::run(), after the main loop:
info!("orchestrator stopped, flushing timeline persistence");
self.timeline_persistence.flush().await;
info!("timeline persistence flushed");
```

The `flush` implementation drops the sender to close the channel, then awaits the `JoinHandle` from `tokio::spawn`. This gives a strong guarantee that all queued events are written before the function returns.

### 4. Error Handling

- **Channel send failure:** `mpsc::UnboundedSender::send` returns `Result`. If the receiver has dropped (background task panicked), the send fails silently. We should log this at `warn` level: `warn!("timeline persist channel closed; event dropped")`.
- **Write failure:** Already handled in the background task (logs `warn!` with `timeline_persist_failed`). The failure is non-fatal and the background task continues processing subsequent events.
- **Background task panic:** If the background task panics, the sender channel is closed. Subsequent sends fail. The orchestrator continues running, but events are lost. This is acceptable for best-effort persistence.

### 5. Testing Strategy

Add tests in `crates/ensemble-core/src/timeline/persistence.rs` (inline `#[cfg(test)]` module):

1. **`send_creates_file_and_writes_event`** — Verify that sending an event results in the JSONL file being created with the correct content.
2. **`ordering_preserved_across_multiple_events`** — Send 10 events in sequence, verify the file has them in order.
3. **`send_returns_immediately`** — Ensure `send()` does not await the write.
4. **`write_failure_is_logged_and_non_fatal`** — Mock a failing writer (e.g., by writing to a read-only path) and verify the background task continues after the failure.
5. **`flush_waits_for_pending_events`** — Send an event, call `flush()` immediately, verify the event is written.

Update existing orchestrator tests:

1. **`publish_pipeline_event_persists_and_broadcasts_with_run_context`** — The test currently awaits `publish_pipeline_event` and then checks the file. With decoupled persistence, the file may not be written yet when the function returns. The test should either await a short delay or check the event via a different mechanism. Since the file write is async, we need to add a small `tokio::time::sleep(Duration::from_millis(10))` or use `flush()` in the test.
2. **`publish_pipeline_event_still_broadcasts_when_timeline_write_fails`** — This test still passes because broadcasting happens before persistence. No change needed.
3. **`publish_pipeline_event_broadcasts_without_run_context`** — No change needed.

### 6. API Compatibility

- The `TimelineWriter` interface is unchanged.
- The `timeline_handler::get_timeline` API is unchanged.
- The WebSocket event stream is unchanged.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Unbounded channel grows under extreme disk backpressure | Low | Medium | Events are tiny (~200 bytes). Even 1000 queued events is ~200KB. If this becomes a concern, we can add a bounded channel with `try_send` and drop + log. |
| Events lost on process crash before flush | Medium | Low | Timeline is best-effort by design. The event bus is the real-time source of truth. |
| Background task panic stops all persistence | Low | Medium | We could add a restart loop in the background task, but this is overkill for best-effort. |
| Test flakiness due to async timing | Medium | Low | Add small sleeps in tests or use `flush()` to synchronize. |

## Relevant Files

- `crates/ensemble-core/src/timeline/persistence.rs` — new file
- `crates/ensemble-core/src/timeline/mod.rs` — add `pub mod persistence;`
- `crates/ensemble-core/src/orchestrator/mod.rs` — replace `timeline_writer` with `timeline_persistence`, update `publish_pipeline_event`, add shutdown flush
- `crates/ensemble-core/src/timeline/writer.rs` — unchanged (used by new actor)

## Open Questions

None. The design is straightforward and the acceptance criteria are fully satisfied.
