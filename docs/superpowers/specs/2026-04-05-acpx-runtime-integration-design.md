# acpx Runtime Integration Design

## Goal

Replace Ensemble's current broken `acpx` runtime integration with a documented `acpx` command/session runtime while preserving a direct execution escape hatch.

Primary outcomes:
- `acpx_agent` uses `acpx`'s real runtime contract rather than raw ACP JSON-RPC.
- Ensemble supports event/log streaming suitable for future web UI live logs.
- The system retains an explicit direct-runtime escape hatch for non-`acpx` use cases.

## Problem

Today Ensemble treats `acpx` like an ACP stdio server. The runtime spawns commands such as:

- `acpx --agent <name> --model <model>`

and then sends ACP JSON-RPC messages such as:

- `initialize`
- `session/new`
- `session/prompt`

That contract is incorrect for the installed/documented `acpx` CLI. `acpx` is a command-oriented runtime wrapper around supported agents. Its documented model is session/command based (`sessions ensure`, `prompt`, `exec`, `cancel`, `sessions close`) with structured JSON output, not raw ACP JSON-RPC over stdin/stdout.

The result is startup hangs and `response timeout after 5000ms` before the first prompt is even accepted.

## Design Principles

1. **Make `acpx` first-class** when `acpx_agent` is configured.
2. **Keep direct execution possible** as an explicit escape hatch.
3. **Design for streaming now** so the web UI can later show live logs without redesigning the backend.
4. **Prefer deterministic orchestration semantics** over conversational carry-over across retries.
5. **Do not preserve the broken hybrid contract** where Ensemble sends ACP JSON-RPC to `acpx`.

## Runtime Architecture

Introduce a runtime abstraction for step execution.

### Runtime kinds

- **AcpxRuntime**
  - Default when `agents.<name>.acpx_agent` is set.
  - Uses `acpx`'s documented command/session contract.
- **DirectRuntime**
  - Explicitly selected lower-level execution path.
  - Retains support for non-`acpx` execution scenarios.

This abstraction replaces the current assumption that all agent execution is ACP-client-shaped.

## Session Model

For `AcpxRuntime`, the session lifecycle is:

- **One session per issue-step attempt**
- **Separate session per step**
- **Fresh session per retry**
- **No session sharing across steps**
- **No session reuse across retries**

Rationale:
- Steps may use different agents.
- Retries should be reproducible and isolated from prior bad state.
- A single step attempt may still internally reuse its own session across multiple turns if Ensemble continues to support multi-turn prompting inside one attempt.

## acpx Command Contract

### Primary command flow

For each issue-step attempt using `AcpxRuntime`:

1. **Ensure session exists**
   - `acpx ... sessions ensure ...`
2. **Start prompt execution**
   - `acpx ... prompt ...` with prompt body provided through stdin or file
3. **Consume structured JSON output as an event stream**
4. **Determine final outcome**
   - success / reject / failure / cancelled
5. **Handle operator cancellation if requested**
   - `acpx ... cancel ...`
6. **Close the session best-effort**
   - `acpx ... sessions close ...`

### Optional one-shot mode

`acpx ... exec ...` may be supported as a simpler operational mode, but it is not the primary orchestration design. The primary model is session-based because it better matches long-running orchestration and future live log requirements.

## Event and Log Streaming Model

Ensemble should treat `acpx` JSON output as a first-class runtime event stream.

Add an internal normalization layer:

- **Raw acpx JSON/NDJSON events**
- mapped into **Ensemble runtime events**

### Normalized event categories

At minimum, the mapping layer should support these event categories:

- session started
- prompt started
- output chunk / log line
- tool activity
- warning
- error
- completed
- cancelled
- malformed event

The mapping should be intentionally broader than what orchestration strictly needs today so that later web UI log rendering can reuse the same event model.

## Orchestrator Integration

The orchestrator should consume normalized runtime events rather than ACP-specific events.

### Short-term usage

In the first implementation, orchestration primarily depends on:
- prompt/session start confirmation
- progress/log events for observability
- completion / cancellation / failure
- structured final outcome

### Long-term usage

The same event stream should later feed:
- web UI live step logs
- richer issue-level event history
- tool invocation visibility
- operator diagnostics

This avoids a second redesign when UI log streaming is implemented.

## Final Outcome Resolution

Final step outcome should come from structured `acpx` completion output plus existing Ensemble conventions.

Resolution order:
1. Use normalized final runtime completion/cancellation/failure events if available.
2. Apply existing workspace/verdict conventions where they still matter (for example `.ensemble/verdict.json` and interaction files).
3. If a final state cannot be determined reliably, fail the step explicitly.

Malformed or partial intermediate log events are **non-fatal** unless they prevent determining the final outcome.

## Cancellation Semantics

Cancellation should be explicit.

- Operator stop/cancel actions trigger runtime cancellation through `acpx ... cancel ...`
- Ensemble should not infer cancellation solely from abrupt process termination
- Final state should distinguish:
  - cancelled by operator
  - failed due to runtime/transport error
  - failed due to agent outcome

## Error Handling

### Startup failures

Treat these as runtime startup failures:
- `sessions ensure` failure
- prompt command launch failure
- immediate invalid/missing required runtime output

### Streaming degradation

If streaming output is partially malformed but final status is still determinable:
- preserve final outcome
- record degraded logging / malformed event diagnostics
- do not fail the step solely because some log events were malformed

### Unknown final state

If the event stream ends and Ensemble cannot determine the final outcome:
- mark the step failed
- include a clear runtime error reason

### Cleanup failures

Best-effort session close should not overwrite the primary step result unless cleanup failure itself is the only available signal and no prior result exists.

## Configuration Behavior

### Default behavior

- `agents.<name>.acpx_agent` implies **AcpxRuntime** by default
- direct runtime is only used when explicitly configured

### Compatibility behavior

Ensemble continues to support both runtime families, but the normal/high-level path is `acpx`.

### Permission behavior

Per-agent `permission_mode` continues to control launch-time `acpx` permission flags where supported by the `acpx` CLI contract.

For `AcpxRuntime`, `agent.permission_request_policy` does not drive runtime permission callbacks and should be treated as unsupported/ignored for that backend. It remains meaningful only for `DirectRuntime` paths that still implement client-side permission handling.

## Testing Strategy

Add tests for:

1. runtime selection
   - `acpx_agent` selects `AcpxRuntime` by default
   - explicit direct configuration selects `DirectRuntime`
2. session lifecycle
   - one session per issue-step attempt
   - separate sessions per step
   - fresh sessions per retry
3. command contract
   - session ensure / prompt / cancel / close invocation shape
4. event mapping
   - valid JSON events map into normalized runtime events
   - malformed events are surfaced as diagnostics, not silent drops
5. outcome resolution
   - success / failure / cancelled / unknown final state
6. cleanup semantics
   - close failures are best-effort
7. regression coverage
   - Ensemble no longer sends ACP JSON-RPC messages to `acpx`

## Migration Notes

The implementation is an architectural pivot in the runtime layer, not a bugfix limited to timeout settings.

The migration should:
- preserve public config compatibility where reasonable
- keep `acpx_agent` user intent intact
- remove the incorrect transport assumption from the runtime internals

## Non-Goals

This design does not require in the first slice:
- full web UI live log rendering
- all possible `acpx` event types to be user-visible
- removal of the direct execution escape hatch
- preserving the current ACP-client implementation as the `acpx` path

## Recommended Implementation Direction

Implement `AcpxRuntime` as the new default runtime for `acpx_agent`, retain `DirectRuntime` as an explicit escape hatch, and build the runtime around structured streaming events from day one.

This is the lowest-risk way to:
- align Ensemble with documented `acpx` behavior,
- preserve `acpx` as the cross-agent abstraction layer,
- and support future web UI logs without another backend redesign.
