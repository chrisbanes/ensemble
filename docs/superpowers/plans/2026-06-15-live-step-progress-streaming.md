# Live Step Progress Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream live per-step transcript records to the web UI while preserving the existing per-step transcript files as the replay source after reconnects.

**Architecture:** Keep the pipeline event stream for coarse run state, and add a separate transcript-record broadcast emitted by `TranscriptPersistence` after it writes the exact JSONL record. The WebSocket sends `snapshot`, `event`, and `transcript_record` messages; the UI merges persisted REST records with live WebSocket records by `(run_id, step_name, sequence)` and refetches transcript history on reconnect.

**Tech Stack:** Rust 2021, tokio broadcast channels, axum WebSockets, serde/utoipa, React 19, TanStack Query, TypeScript/Vitest.

---

## File Structure

- Modify `crates/ensemble-core/src/transcript/mod.rs`: export the new transcript event bus module.
- Create `crates/ensemble-core/src/transcript/events.rs`: typed broadcast bus for appended `TranscriptRecord`s.
- Modify `crates/ensemble-core/src/transcript/persistence.rs`: accept an optional transcript bus and publish records after successful append.
- Modify `crates/ensemble-core/src/orchestrator/mod.rs`: thread `TranscriptEventBus` through `OrchestratorRuntimeParts` and `TranscriptPersistence`.
- Modify `crates/ensemble-core/src/api/router.rs`: add `transcript_event_bus` to `AppState`.
- Modify `crates/ensemble-core/src/api/bootstrap.rs`: create and share the transcript event bus with API and orchestrator runtime.
- Modify `crates/ensemble-core/src/api/ws.rs`: subscribe to both pipeline events and transcript records; serialize `transcript_record` WebSocket messages.
- Modify `crates/ensemble-core/src/api/test_helpers.rs` and test builders in `crates/ensemble-core/src/api/*`, `crates/ensemble-core/tests/api_endpoints.rs`: provide `TranscriptEventBus::new()` where `AppState` is constructed.
- Modify `crates/ensemble-ui/src-ui/src/ws-events.ts`: add `WsTranscriptRecordMessage`, `WsMessage`, and transcript-record dedupe helpers.
- Modify `crates/ensemble-ui/src-ui/src/ws-types.ts`: re-export the expanded WebSocket message types.
- Modify `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`: keep live transcript records in local state, reset/refetch on snapshots, and merge them with query records.
- Modify `crates/ensemble-ui/src-ui/src/components/transcript/transcript-model.ts`: no behavioral change expected unless dedupe needs a helper; use existing `transcriptRecords` input.
- Modify `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx` and `crates/ensemble-ui/src-ui/src/ws-events.test.ts`: cover live transcript append and reconnect/refetch behavior.
- Modify `docs/SPEC.md` and `docs/pipelines.md`: document live WebSocket transcript messages and replay semantics.

---

### Task 1: Add A Transcript Record Broadcast Bus

**Files:**
- Create: `crates/ensemble-core/src/transcript/events.rs`
- Modify: `crates/ensemble-core/src/transcript/mod.rs`
- Test: `crates/ensemble-core/src/transcript/events.rs`

- [ ] **Step 1: Write the event bus module**

Create `crates/ensemble-core/src/transcript/events.rs`:

```rust
use tokio::sync::broadcast;

use super::model::TranscriptRecord;

const TRANSCRIPT_EVENT_BUS_CAPACITY: usize = 4096;

#[derive(Debug, Clone)]
pub struct TranscriptEventBus {
    sender: broadcast::Sender<TranscriptRecord>,
}

impl TranscriptEventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(TRANSCRIPT_EVENT_BUS_CAPACITY);
        Self { sender }
    }

    pub fn publish(&self, record: TranscriptRecord) {
        let _ = self.sender.send(record);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TranscriptRecord> {
        self.sender.subscribe()
    }
}

impl Default for TranscriptEventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::model::{
        TranscriptRecord, TranscriptRecordKind, TRANSCRIPT_SCHEMA_VERSION,
    };
    use chrono::Utc;

    fn record() -> TranscriptRecord {
        TranscriptRecord {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            sequence: 1,
            timestamp: Utc::now(),
            kind: TranscriptRecordKind::AssistantMessage,
            payload: serde_json::json!({"text": "hello"}),
            truncated: None,
        }
    }

    #[tokio::test]
    async fn publish_and_receive_transcript_record() {
        let bus = TranscriptEventBus::new();
        let mut rx = bus.subscribe();

        bus.publish(record());

        let received = rx.recv().await.unwrap();
        assert_eq!(received.issue_identifier, "repo#1");
        assert_eq!(received.run_id, "run-1");
        assert_eq!(received.step_name, "build");
        assert_eq!(received.sequence, 1);
    }
}
```

- [ ] **Step 2: Export the module**

In `crates/ensemble-core/src/transcript/mod.rs`, add:

```rust
pub mod events;
```

- [ ] **Step 3: Run the targeted test**

Run:

```bash
rtk cargo test -p ensemble-core transcript::events
```

Expected: the new event bus test passes.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/transcript/events.rs crates/ensemble-core/src/transcript/mod.rs
git commit -m "feat: add transcript event bus"
```

---

### Task 2: Publish Appended Transcript Records

**Files:**
- Modify: `crates/ensemble-core/src/transcript/persistence.rs`
- Test: `crates/ensemble-core/src/transcript/persistence.rs`

- [ ] **Step 1: Add a failing persistence broadcast test**

In the existing `#[cfg(test)] mod tests` in `crates/ensemble-core/src/transcript/persistence.rs`, add:

```rust
#[tokio::test]
async fn persistence_publishes_after_successful_append() {
    let temp_dir = TempDir::new().unwrap();
    let bus = crate::transcript::events::TranscriptEventBus::new();
    let mut rx = bus.subscribe();
    let mut persistence =
        TranscriptPersistence::new_with_event_bus(temp_dir.path().to_path_buf(), bus);

    persistence.send(TranscriptPersistRequest {
        run_id: "run-1".to_string(),
        issue_identifier: "repo#1".to_string(),
        step_name: "build".to_string(),
        attempt: 1,
        timestamp: Utc::now(),
        kind: TranscriptRecordKind::ToolCall,
        payload: serde_json::json!({"name": "read_file"}),
        truncated: None,
    });

    let received = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .unwrap()
        .unwrap();
    persistence.flush().await;

    assert_eq!(received.run_id, "run-1");
    assert_eq!(received.step_name, "build");
    assert_eq!(received.sequence, 1);
    assert_eq!(received.payload["name"], "read_file");
}

#[tokio::test]
async fn persistence_publishes_coalesced_record_on_flush() {
    let temp_dir = TempDir::new().unwrap();
    let bus = crate::transcript::events::TranscriptEventBus::new();
    let mut rx = bus.subscribe();
    let mut persistence =
        TranscriptPersistence::new_with_event_bus(temp_dir.path().to_path_buf(), bus);

    for text in ["hel", "lo"] {
        persistence.send(TranscriptPersistRequest {
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            timestamp: Utc::now(),
            kind: TranscriptRecordKind::AssistantMessage,
            payload: serde_json::json!({"text": text}),
            truncated: None,
        });
    }
    persistence.flush_step("run-1".to_string(), "build".to_string());

    let received = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .unwrap()
        .unwrap();
    persistence.flush().await;

    assert_eq!(received.sequence, 1);
    assert_eq!(received.payload["text"], "hello");
}
```

- [ ] **Step 2: Run the tests to verify failure**

Run:

```bash
rtk cargo test -p ensemble-core transcript::persistence::tests::persistence_publishes
```

Expected: compile failure because `TranscriptPersistence::new_with_event_bus` does not exist.

- [ ] **Step 3: Implement optional broadcasting**

In `crates/ensemble-core/src/transcript/persistence.rs`, import the bus:

```rust
use super::events::TranscriptEventBus;
```

Change `TranscriptPersistence::new` and add `new_with_event_bus`:

```rust
impl TranscriptPersistence {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self::new_internal(workspace_root, None)
    }

    pub fn new_with_event_bus(workspace_root: PathBuf, event_bus: TranscriptEventBus) -> Self {
        Self::new_internal(workspace_root, Some(event_bus))
    }

    fn new_internal(workspace_root: PathBuf, event_bus: Option<TranscriptEventBus>) -> Self {
        let writer = TranscriptWriter::new(workspace_root);
        let (sender, mut receiver) = mpsc::channel::<TranscriptPersistCommand>(10_000);

        let handle = tokio::spawn(async move {
            let mut state = PersistState::default();
            while let Some(command) = receiver.recv().await {
                match command {
                    TranscriptPersistCommand::Record(req) => {
                        state.write_request(&writer, req, event_bus.as_ref()).await;
                    }
                    TranscriptPersistCommand::FlushStep { run_id, step_name } => {
                        state.flush_step(&writer, &run_id, &step_name, event_bus.as_ref()).await;
                    }
                }
            }
            state.flush_all(&writer, event_bus.as_ref()).await;
        });

        Self {
            sender: Some(sender),
            handle: Some(handle),
        }
    }
}
```

Thread `event_bus: Option<&TranscriptEventBus>` through `write_request`, `flush_key`, `flush_step`, `flush_all`, and `append`. In `append`, publish only after `writer.append(&record).await` succeeds:

```rust
match writer.append(&record).await {
    Ok(()) => {
        if let Some(event_bus) = event_bus {
            event_bus.publish(record);
        }
    }
    Err(error) => {
        warn!(
            event = "transcript_persist_failed",
            run_id = %record.run_id,
            step_name = %record.step_name,
            error = %error,
            "failed to persist transcript record"
        );
    }
}
```

- [ ] **Step 4: Run the targeted tests**

Run:

```bash
rtk cargo test -p ensemble-core transcript::persistence
```

Expected: all transcript persistence tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/transcript/persistence.rs
git commit -m "feat: broadcast persisted transcript records"
```

---

### Task 3: Thread The Transcript Bus Through Runtime State

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/api/router.rs`
- Modify: `crates/ensemble-core/src/api/bootstrap.rs`
- Modify: `crates/ensemble-core/src/api/test_helpers.rs`
- Modify: `crates/ensemble-core/src/api/config_handler.rs`
- Modify: `crates/ensemble-core/src/api/controls.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Modify: `crates/ensemble-core/src/api/history_handler.rs`
- Modify: `crates/ensemble-core/src/api/timeline_handler.rs`
- Modify: `crates/ensemble-core/tests/api_endpoints.rs`
- Test: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Add a failing orchestrator broadcast test**

In `crates/ensemble-core/src/orchestrator/mod.rs`, add beside `handle_agent_update_persists_transcript_block`:

```rust
#[tokio::test]
async fn handle_agent_update_broadcasts_persisted_transcript_record() {
    let config = Arc::new(RwLock::new(make_config()));
    let tracker: Arc<dyn IssueTracker> = Arc::new(MockTracker {
        issues: Arc::new(RwLock::new(vec![])),
    });
    let runner: Arc<dyn AgentRunner> = Arc::new(MockRunner {
        delay_ms: 0,
        observed_commands: None,
        observed_timeouts: None,
        cancellation_probe: None,
    });
    let dir = tempfile::TempDir::new().unwrap();
    let workspace_mgr = WorkspaceManager::new(dir.path(), None).unwrap();
    let (_shutdown_tx, shutdown_rx) = mpsc::channel(1);
    let transcript_event_bus = crate::transcript::events::TranscriptEventBus::new();
    let mut rx = transcript_event_bus.subscribe();

    let orchestrator = Orchestrator::new_with_state(
        OrchestratorRuntimeParts {
            state: Arc::new(RwLock::new(OrchestratorState::new(
                30_000,
                &ConcurrencyConfig::default(),
            ))),
            config,
            tracker,
            agent_runner: runner,
            workspace_mgr,
            refresh_requested: Arc::new(tokio::sync::Notify::new()),
            cancellation_registry: new_cancellation_registry(),
            event_bus: EventBus::new(),
            transcript_event_bus,
            workspace_root: dir.path().to_path_buf(),
        },
        dir.path(),
        shutdown_rx,
    );

    {
        let mut state = orchestrator.state.write().await;
        state.add_running(&test_issue("issue-1", "Todo"), None);
        let entry = state.running.get_mut("issue-1").unwrap();
        entry.identifier = "repo#1".to_string();
        entry.run_id = Some("run-1".to_string());
    }

    orchestrator
        .handle_worker_event(WorkerEvent::AgentUpdate {
            issue_id: "issue-1".to_string(),
            step_name: "build".to_string(),
            event: AgentEvent::TranscriptBlock {
                kind: crate::agent::protocol::TranscriptBlockKind::AssistantMessage,
                payload: serde_json::json!({"text": "hello"}),
            },
            timestamp: chrono::Utc::now(),
        })
        .await;
    orchestrator
        .handle_worker_event(WorkerEvent::AgentUpdate {
            issue_id: "issue-1".to_string(),
            step_name: "build".to_string(),
            event: AgentEvent::RunCompleted { usage: None },
            timestamp: chrono::Utc::now(),
        })
        .await;

    let received = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(received.issue_identifier, "repo#1");
    assert_eq!(received.run_id, "run-1");
    assert_eq!(received.step_name, "build");
    assert_eq!(received.payload["text"], "hello");
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
rtk cargo test -p ensemble-core handle_agent_update_broadcasts_persisted_transcript_record
```

Expected: compile failure because `transcript_event_bus` is not threaded through runtime parts.

- [ ] **Step 3: Add the bus to orchestrator runtime parts**

In `crates/ensemble-core/src/orchestrator/mod.rs`, import and store the bus:

```rust
use crate::transcript::events::TranscriptEventBus;
```

Add to `OrchestratorRuntimeParts`:

```rust
pub transcript_event_bus: TranscriptEventBus,
```

In `Orchestrator::new`, initialize it:

```rust
transcript_event_bus: TranscriptEventBus::new(),
```

In `new_with_state`, construct transcript persistence with the shared bus:

```rust
transcript_persistence: Some(TranscriptPersistence::new_with_event_bus(
    parts.workspace_root,
    parts.transcript_event_bus,
)),
```

Update all `OrchestratorRuntimeParts` construction sites in this file to include:

```rust
transcript_event_bus: TranscriptEventBus::new(),
```

- [ ] **Step 4: Add the bus to API state and bootstrap**

In `crates/ensemble-core/src/api/router.rs`, import and add:

```rust
use crate::transcript::events::TranscriptEventBus;

pub transcript_event_bus: TranscriptEventBus,
```

In `crates/ensemble-core/src/api/bootstrap.rs`, import `TranscriptEventBus`, create one in `build_app_state`, and pass it to the orchestrator:

```rust
let transcript_event_bus = TranscriptEventBus::new();

let app_state = AppState {
    transcript_event_bus,
    // existing fields
};
```

Then in `prepare_orchestrator_runtime`:

```rust
transcript_event_bus: app_state.transcript_event_bus.clone(),
```

Update every `AppState { ... }` test builder to include:

```rust
transcript_event_bus: TranscriptEventBus::new(),
```

- [ ] **Step 5: Run backend compile and the targeted orchestrator test**

Run:

```bash
rtk cargo test -p ensemble-core handle_agent_update_broadcasts_persisted_transcript_record
rtk cargo check -p ensemble-core
```

Expected: the targeted test passes and `ensemble-core` compiles.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs crates/ensemble-core/src/api/router.rs crates/ensemble-core/src/api/bootstrap.rs crates/ensemble-core/src/api/test_helpers.rs crates/ensemble-core/src/api/config_handler.rs crates/ensemble-core/src/api/controls.rs crates/ensemble-core/src/api/handlers.rs crates/ensemble-core/src/api/history_handler.rs crates/ensemble-core/src/api/timeline_handler.rs crates/ensemble-core/tests/api_endpoints.rs
git commit -m "feat: share transcript stream bus with runtime"
```

---

### Task 4: Send Transcript Records Over WebSocket

**Files:**
- Modify: `crates/ensemble-core/src/api/ws.rs`
- Test: `crates/ensemble-core/src/api/ws.rs`

- [ ] **Step 1: Add serializable WebSocket message helpers and tests**

In `crates/ensemble-core/src/api/ws.rs`, add near the imports:

```rust
use crate::transcript::model::TranscriptRecord;
use crate::observability::snapshot::IssueDetailSnapshot;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsServerMessage<'a> {
    Snapshot { data: &'a Option<IssueDetailSnapshot> },
    Event { data: &'a PipelineEvent },
    TranscriptRecord { data: &'a TranscriptRecord },
}
```

In the `tests` module, add:

```rust
#[test]
fn transcript_record_message_serializes_with_stable_type() {
    let record = crate::transcript::model::TranscriptRecord {
        schema_version: crate::transcript::model::TRANSCRIPT_SCHEMA_VERSION,
        run_id: "run-1".to_string(),
        issue_identifier: "repo#1".to_string(),
        step_name: "build".to_string(),
        attempt: 1,
        sequence: 3,
        timestamp: chrono::Utc::now(),
        kind: crate::transcript::model::TranscriptRecordKind::AssistantMessage,
        payload: serde_json::json!({"text": "hello"}),
        truncated: None,
    };

    let value = serde_json::to_value(WsServerMessage::TranscriptRecord { data: &record }).unwrap();

    assert_eq!(value["type"], "transcript_record");
    assert_eq!(value["data"]["issue_identifier"], "repo#1");
    assert_eq!(value["data"]["sequence"], 3);
    assert_eq!(value["data"]["payload"]["text"], "hello");
}
```

- [ ] **Step 2: Run the new serialization test**

Run:

```bash
rtk cargo test -p ensemble-core transcript_record_message_serializes_with_stable_type
```

Expected: compile failure until the helper type and snapshot type are correct.

- [ ] **Step 3: Subscribe to transcript records in `handle_ws`**

In `handle_ws`, after subscribing to `state.event_bus`, add:

```rust
let mut transcript_rx = state.transcript_event_bus.subscribe();
```

Replace ad-hoc `serde_json::json!` WebSocket payloads with `WsServerMessage` serialization. Add a third `tokio::select!` branch:

```rust
record = transcript_rx.recv() => {
    match record {
        Ok(record) if record.issue_identifier == identifier => {
            let msg = WsServerMessage::TranscriptRecord { data: &record };
            if sender
                .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                .await
                .is_err()
            {
                debug!(identifier = %identifier, "WebSocket client disconnected");
                break;
            }
        }
        Ok(_) => {}
        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
            warn!(identifier = %identifier, lagged = n, "WebSocket transcript subscriber lagged");
        }
        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
            debug!(identifier = %identifier, "transcript event bus closed, closing WebSocket");
            break;
        }
    }
}
```

Keep the existing `Complete` close behavior for pipeline events. Transcript records should not close the socket.

- [ ] **Step 4: Run targeted backend verification**

Run:

```bash
rtk cargo test -p ensemble-core ws
rtk cargo check -p ensemble-core
```

Expected: `ws` tests pass and `ensemble-core` compiles.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/api/ws.rs
git commit -m "feat: stream transcript records over websocket"
```

---

### Task 5: Add Frontend WebSocket Transcript Types

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/ws-events.ts`
- Modify: `crates/ensemble-ui/src-ui/src/ws-types.ts`
- Test: `crates/ensemble-ui/src-ui/src/ws-events.test.ts`

- [ ] **Step 1: Add frontend type tests**

In `crates/ensemble-ui/src-ui/src/ws-events.test.ts`, add:

```ts
import { transcriptRecordKey } from "./ws-events";

it("builds a stable transcript record key", () => {
  expect(
    transcriptRecordKey({
      schema_version: 1,
      run_id: "run-1",
      issue_identifier: "repo#1",
      step_name: "build",
      attempt: 1,
      sequence: 7,
      timestamp: "2026-06-15T10:00:00Z",
      kind: "assistant_message",
      payload: { text: "hello" },
    }),
  ).toBe("run-1:build:7");
});
```

- [ ] **Step 2: Run the test to verify failure**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test ws-events.test.ts
```

Expected: TypeScript failure because `transcriptRecordKey` is not exported.

- [ ] **Step 3: Implement transcript message types and key helper**

In `crates/ensemble-ui/src-ui/src/ws-events.ts`, import the generated type and add:

```ts
import type { IssueDetailSnapshot, TranscriptRecord } from "./generated/models";

export interface WsTranscriptRecordMessage {
  type: "transcript_record";
  data: TranscriptRecord;
}

export type WsMessage = WsSnapshotMessage | WsEventMessage | WsTranscriptRecordMessage;

export function transcriptRecordKey(record: TranscriptRecord): string {
  return `${record.run_id}:${record.step_name}:${record.sequence}`;
}
```

Remove the duplicate `IssueDetailSnapshot` import if needed.

In `crates/ensemble-ui/src-ui/src/ws-types.ts`, export the new names:

```ts
export type {
  WsEventData,
  WsEventMessage,
  WsMessage,
  WsPipelineEvent,
  WsSnapshotMessage,
  WsTranscriptRecordMessage,
} from "./ws-events";

import type { WsMessage } from "./ws-events";
```

- [ ] **Step 4: Run the frontend targeted test**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test ws-events.test.ts
```

Expected: `ws-events.test.ts` passes.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/ws-events.ts crates/ensemble-ui/src-ui/src/ws-types.ts crates/ensemble-ui/src-ui/src/ws-events.test.ts
git commit -m "feat: type websocket transcript records"
```

---

### Task 6: Merge Live Transcript Records Into Issue Detail

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Test: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Add failing UI tests**

In `IssueDetail.test.tsx`, extend the existing `@/ws` mock so tests can capture `onMessage`. Add a test that renders an active issue with `run_id: "run-1"` and `step_name: "build"`, sends:

```ts
capturedWsOptions.onMessage({
  type: "transcript_record",
  data: {
    schema_version: 1,
    run_id: "run-1",
    issue_identifier: "todo-1",
    step_name: "build",
    attempt: 1,
    sequence: 2,
    timestamp: "2026-06-15T10:00:00Z",
    kind: "assistant_message",
    payload: { text: "live hello" },
  },
});
```

Assert:

```ts
expect(await screen.findByText("live hello")).toBeInTheDocument();
```

Add a second test that seeds the REST transcript query with the same `run_id`, `step_name`, and `sequence`, sends the same WebSocket record, and asserts only one matching entry is rendered:

```ts
expect(screen.getAllByText("live hello")).toHaveLength(1);
```

- [ ] **Step 2: Run the failing UI tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test IssueDetail.test.tsx
```

Expected: tests fail because `IssueDetail` ignores `transcript_record` messages.

- [ ] **Step 3: Implement live transcript state and dedupe**

In `IssueDetail.tsx`, import:

```ts
import type { TranscriptRecord } from "@/generated/models";
import { isCompletionEvent, normalizePipelineEvent, timelineRecordToEventData, transcriptRecordKey } from "@/ws-events";
```

Add state:

```ts
const [liveTranscriptRecords, setLiveTranscriptRecords] = useState<TranscriptRecord[]>([]);
```

Build merged transcript records:

```ts
const transcriptRecords = useMemo(() => {
  const byKey = new Map<string, TranscriptRecord>();
  for (const record of transcriptQuery.data?.records ?? []) {
    byKey.set(transcriptRecordKey(record), record);
  }
  for (const record of liveTranscriptRecords) {
    if (record.run_id !== effectiveRunId || record.step_name !== activeStepName) continue;
    byKey.set(transcriptRecordKey(record), record);
  }
  return Array.from(byKey.values()).sort((a, b) => a.sequence - b.sequence);
}, [activeStepName, effectiveRunId, liveTranscriptRecords, transcriptQuery.data?.records]);
```

Use `transcriptRecords` in `reconcileGroupedTranscriptEntries`:

```ts
transcriptRecords,
```

Update the WebSocket handler:

```ts
if (msg.type === "snapshot") {
  setLiveEvents([]);
  setLiveTranscriptRecords([]);
  void transcriptQuery.refetch();
  void timelineQuery.refetch();
} else if (msg.type === "event") {
  // existing event handling
} else if (msg.type === "transcript_record") {
  setLiveTranscriptRecords((prev) => {
    const next = new Map(prev.map((record) => [transcriptRecordKey(record), record] as const));
    next.set(transcriptRecordKey(msg.data), msg.data);
    return Array.from(next.values()).sort((a, b) => a.sequence - b.sequence);
  });
}
```

Make sure the effect dependency list includes `transcriptQuery` and `timelineQuery` refetch functions in a stable way. If the query objects make the dependency list noisy, destructure before the effect:

```ts
const refetchTranscript = transcriptQuery.refetch;
const refetchTimeline = timelineQuery.refetch;
```

Then depend on `refetchTranscript` and `refetchTimeline`.

- [ ] **Step 4: Clear live records on session changes**

Add:

```ts
useEffect(() => {
  setLiveTranscriptRecords([]);
}, [transcriptSessionKey]);
```

- [ ] **Step 5: Run the UI tests**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test IssueDetail.test.tsx ws-events.test.ts
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx
git commit -m "feat: render live transcript websocket records"
```

---

### Task 7: Update API Documentation

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/pipelines.md`

- [ ] **Step 1: Update `docs/SPEC.md`**

In the WebSocket/API section, document:

```markdown
The issue WebSocket at `/ws/events/{identifier}` emits three message kinds:

- `snapshot`: current issue detail snapshot sent when the socket connects.
- `event`: coarse pipeline event used by the run timeline.
- `transcript_record`: a persisted per-step transcript record, emitted after the same record has been appended to `.ensemble/runs/{run_id}/steps/{step_name}/transcript.jsonl`.

Clients should treat transcript files and the step conversation API as the replay source. On reconnect, clients should refetch the active step conversation and then merge subsequent `transcript_record` messages by `(run_id, step_name, sequence)`.
```

- [ ] **Step 2: Update `docs/pipelines.md`**

In the step transcript section, add:

```markdown
While a step is running, newly persisted transcript records are streamed over the issue WebSocket as `transcript_record` messages. The live stream is best-effort; the step conversation API remains the source of truth for reconnect replay and historical inspection.
```

- [ ] **Step 3: Commit**

```bash
git add docs/SPEC.md docs/pipelines.md
git commit -m "docs: describe live transcript streaming"
```

---

### Task 8: Full Verification

**Files:**
- No source edits expected.

- [ ] **Step 1: Regenerate frontend API client**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm run codegen
```

Expected: generated client exists under `crates/ensemble-ui/src-ui/src/generated`. Commit generated changes if the OpenAPI output changes.

- [ ] **Step 2: Run backend checks**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
rtk SKIP_UI_BUILD=1 cargo test -p ensemble-cli --features web-ui --test product_e2e -- --nocapture
rtk SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
```

Expected: all pass.

- [ ] **Step 3: Run frontend checks**

Run:

```bash
cd crates/ensemble-ui/src-ui
rtk pnpm test
rtk pnpm run build
```

Expected: Vitest and production build pass.

- [ ] **Step 4: Manual smoke test**

Run:

```bash
rtk SKIP_UI_BUILD=1 cargo run -p ensemble-cli --features web-ui -- web --port 9131
```

Open the issue detail page for a running issue. Confirm the transcript pane updates with assistant text/tool activity while the step is still running, then reload the page and confirm the same entries reappear from the step conversation API.

---

## Self-Review

- Spec coverage: issue 182 requires live per-step agent events, WebSocket delivery, UI rendering, coalescing reuse, and replay on reconnect. Tasks 1-4 stream exactly persisted/coalesced `TranscriptRecord`s, Tasks 5-6 render them live and dedupe against replayed REST records, Task 7 documents the contract.
- Placeholder scan: no task depends on unspecified behavior; all new message names, keys, files, and verification commands are named.
- Type consistency: backend message type is `transcript_record`; frontend `WsTranscriptRecordMessage` uses the generated `TranscriptRecord`; dedupe key is consistently `(run_id, step_name, sequence)`.
