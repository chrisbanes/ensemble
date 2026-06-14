# Per-Step Conversation Transcript Design

Date: 2026-06-14
Status: Approved for implementation planning

## Goal

Add a per-step JSONL transcript that records what happened inside each agent step:
assistant messages, reasoning chunks when exposed by the runtime, tool calls, tool results,
permission activity, prompt metadata, and turn completion details.

This transcript is separate from the pipeline timeline. The timeline remains a compact event stream
for step state transitions and run progress. The transcript is the drill-down record operators use
when they need to debug a specific step.

## Context

Issue 181 requests one JSONL transcript file per pipeline step. The existing timeline writer already
persists run-level events under `.ensemble/runs/{run_id}/events.jsonl`, but timeline events are too
coarse and intentionally truncate output.

The current conversation API reads `{workspace}/.ensemble/conversation.jsonl`, but the project does
not need to preserve that route or data shape. The correct long-term design is a run and step scoped
transcript contract.

The current ACP parsing path also loses important transcript data before the orchestrator sees it.
`parse_session_update` preserves assistant text, usage, stop reason, permission request, and verdict,
but not structured tool-call updates, tool results, or reasoning chunks. A persistence sink that only
consumes today's `AgentEvent` values would therefore miss key content from the issue.

## Requirements

1. Persist one transcript file per run step.
2. Preserve assistant text, reasoning chunks, tool calls, tool results, prompt metadata, permission
   activity, turn completion, and errors when the runtime exposes them.
3. Do not rely on pipeline timeline events to reconstruct the transcript.
4. Coalesce adjacent text and reasoning deltas so transcripts do not contain thousands of tiny rows.
5. Truncate large tool results using head and tail retention while recording truncation metadata.
6. Replace the old issue-level conversation API with run and step scoped transcript endpoints.
7. Keep transcript file I/O off the orchestrator hot path.
8. Update documentation because this changes the API contract and runtime persistence behavior.

## Storage Layout

Store transcript rows at:

```text
{workspace}/.ensemble/runs/{run_id}/steps/{step_name}/transcript.jsonl
```

`step_name` must be sanitized before being used as a path segment. The implementation should either
reuse an existing workspace-key style sanitizer or add a small sanitizer that accepts normal pipeline
step names and rejects or encodes path separators.

This path intentionally lives beside run timeline storage so a run's timeline and step transcripts
can be inspected together.

## Transcript Record Model

Each JSONL line should deserialize as a typed `TranscriptRecord`.

```text
schema_version: u32
run_id: String
issue_identifier: String
step_name: String
attempt: u32
sequence: u64
timestamp: DateTime<Utc>
kind: TranscriptRecordKind
payload: serde_json::Value
truncated: Option<TranscriptTruncation>
```

Initial record kinds:

```text
prompt
assistant_message
reasoning
tool_call
tool_result
permission_request
permission_resolution
turn_complete
error
raw
```

`payload` is kind-specific and should preserve structured protocol data where practical. For example,
tool calls should keep the tool call id, tool name, arguments, and status fields when present rather
than reducing them to a display string.

`raw` is a fallback for transcript-worthy data that cannot yet be normalized safely. It should not be
used for every ACP message, because that would turn the transcript into a protocol dump.

## ACP Runtime Flow

Extend the ACP parser to return transcript blocks in addition to its current reduced fields.

The existing normalized fields remain useful for verdict extraction, token accounting, and state
updates. The new transcript blocks are for persistence and UI drill-down.

The parser should recognize these logical categories from `session/update` payloads:

- assistant text/message chunks
- reasoning chunks when present
- tool-call updates, including call id, tool name, arguments, and lifecycle status
- tool-result or tool-output blocks
- permission requests
- stop reason and usage updates
- final structured result/verdict payloads

Both runtime paths must emit transcript data:

- the `acpx` CLI/session path reading JSON-RPC lines from stdout
- the direct ACP SDK path reading dispatch/session messages

The runtime layer should not decide final storage paths. It should emit transcript blocks through the
worker/orchestrator event channel with issue id, step name, and timestamp, matching the current worker
event shape.

## Orchestrator And Persistence

Add a `TranscriptWriter` and `TranscriptPersistence` module parallel to timeline persistence.

Responsibilities:

- compute the per-run, per-step transcript path
- append JSONL records
- create parent directories as needed
- assign monotonically increasing sequence numbers per `(run_id, step_name)`
- buffer and coalesce adjacent assistant/reasoning deltas
- truncate large tool output before writing
- expose a flush path for orchestrator shutdown and tests

The orchestrator should resolve run context in the same place it handles agent updates. When a
transcript block arrives without a run id, it should still update in-memory state if appropriate but
skip persistence and log a warning. Missing run context should not crash the worker loop.

Coalescing should happen in transcript persistence or a small helper owned by that module, not in the
parser. The parser should report protocol facts; persistence should decide how to batch noisy deltas.

## Coalescing

Coalesce adjacent records when all of these are true:

- same `run_id`
- same `step_name`
- same `kind` of `assistant_message` or `reasoning`
- same logical source stream, if the runtime exposes one
- the accumulated content remains below the configured or constant byte threshold
- the elapsed time since the previous fragment remains within the configured or constant window

Reasonable first constants:

```text
coalesce_window_ms = 250
coalesce_max_bytes = 16 KiB
```

Flush coalesced records when a different kind arrives, a size/time threshold is exceeded, the worker
exits, or the orchestrator shuts down.

## Truncation

Large tool results should be truncated before persistence using head and tail retention.

Recommended first constants:

```text
tool_result_max_bytes = 128 KiB
tool_result_head_bytes = 96 KiB
tool_result_tail_bytes = 32 KiB
```

Truncation metadata should include:

```text
original_bytes
retained_head_bytes
retained_tail_bytes
```

The retained payload must remain valid JSON. If a structured value is too large, store a structured
wrapper that contains the retained text representation and truncation metadata instead of writing
invalid partial JSON.

## API Contract

Replace the old issue-level conversation route with run and step scoped transcript routes.

```text
GET /api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation
GET /api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation/{sequence}
```

The list endpoint should support cursor and limit pagination. The single-record endpoint should
return one transcript row by sequence.

Responses should return transcript records, not the old role/content `ConversationMessage` shape.
Missing transcript files should return an empty list for the list endpoint and `404` for a specific
sequence lookup.

Path inputs must be validated:

- `identifier` is sanitized to the workspace key, as the existing API does.
- `run_id` must reject path traversal and separators.
- `step_name` must use the same step-name path sanitizer as the writer.

## UI Integration

The run transcript UI should consume step-scoped transcript records as the primary conversation
source. Timeline and interaction data remain supporting sources for run-level state, human Q&A, and
navigation.

The first UI integration can load transcript records for the currently selected or active step. A
later enhancement can prefetch transcripts for all visible steps if performance and UX require it.

The frontend transcript model should map backend record kinds to existing presentation entries:

- `assistant_message` -> agent message entries
- `reasoning`, `tool_call`, `tool_result`, and `raw` -> collapsed tool/activity groups by default
- `permission_request` and `permission_resolution` -> warning or workflow activity entries
- `turn_complete` -> compact step/turn event
- `error` -> error entry

## Error Handling

Transcript persistence failures should not fail the agent step. They should be logged with enough
context to diagnose the affected run and step.

API parse failures should return an internal error because malformed JSONL indicates corrupted local
state. Missing files are not errors for list reads.

If the runtime exposes an unknown transcript block, preserve it as `raw` only when it is useful for
operator debugging and small enough to retain safely. Otherwise, summarize it as a warning/error
record.

## Testing

Backend tests should cover:

- parser extraction of assistant messages, reasoning chunks, tool-call updates, tool results,
  permission requests, usage, and stop reasons
- `TranscriptWriter` path construction and append-only JSONL behavior
- transcript persistence ordering and flush behavior
- coalescing adjacent assistant/reasoning deltas
- head/tail truncation of large tool results
- API pagination, missing-file behavior, malformed JSONL behavior, and path validation
- product E2E fixture proving a mock ACP stream writes a per-step transcript

Frontend tests should cover:

- transcript API client model changes
- mapping backend transcript record kinds into normalized UI transcript entries
- collapsed rendering for reasoning/tool records
- loading transcript data for the selected or active step

## Documentation

Update the canonical docs that describe:

- agent runtime persistence behavior in `docs/SPEC.md`
- pipeline/transcript debugging behavior in `docs/pipelines.md`
- API route behavior if an API reference section exists or is generated from OpenAPI

Because the old issue-level conversation route is intentionally replaced, docs and generated client
types should not keep describing it as the primary contract.

## Open Implementation Notes

The implementation plan should decide the exact Rust module names, but the likely split is:

- `crates/ensemble-core/src/transcript/model.rs`
- `crates/ensemble-core/src/transcript/writer.rs`
- `crates/ensemble-core/src/transcript/persistence.rs`
- `crates/ensemble-core/src/api/conversation.rs` rewritten around transcript records

The old `conversation.rs` module name can remain for API route compatibility with generated frontend
names, but the data contract should be transcript-based.
