# Poll Countdown Design

Show a countdown on the dashboard indicating when the next backend orchestrator poll will fire.

## Motivation

The orchestrator polls the tracker on a configurable interval (default 30s). Users watching the dashboard have no visibility into when the next poll will happen — they either wait or spam Force Refresh. A simple countdown next to the Force Refresh button removes this uncertainty.

## Backend changes

### OrchestratorState

Add one field to `OrchestratorState` in `crates/ensemble-core/src/orchestrator/state.rs`:

```rust
pub last_tick_at: Option<DateTime<Utc>>,
```

Initialized as `None` in `OrchestratorState::new()`.

Set to `Some(Utc::now())` at the start of `handle_tick()` in `crates/ensemble-core/src/orchestrator/mod.rs`, before the poll/dispatch/reconcile phases.

### RuntimeSnapshot

Add two fields to `RuntimeSnapshot` in `crates/ensemble-core/src/observability/snapshot.rs`:

```rust
pub poll_interval_ms: u64,
pub last_tick_at: Option<DateTime<Utc>>,
```

Populated from `OrchestratorState` in `build_state_snapshot()`:

```rust
poll_interval_ms: state.poll_interval_ms,
last_tick_at: state.last_tick_at,
```

### OpenAPI

The new fields appear automatically via `utoipa::ToSchema` derives. After the Rust changes, re-run `pnpm run codegen` in `crates/ensemble-ui/src-ui/` to regenerate the TypeScript client types.

## Frontend changes

### Countdown hook

New hook in `crates/ensemble-ui/src-ui/src/hooks.ts`:

```typescript
function useNextPollCountdown(
  lastTickAt: string | null | undefined,
  pollIntervalMs: number | undefined
): number | null
```

Behavior:
- Returns `null` when `lastTickAt` is not yet available (orchestrator hasn't ticked).
- Uses `useState` + `setInterval(1000)` to compute `secondsRemaining = Math.max(0, Math.ceil((lastTickMs + pollIntervalMs - Date.now()) / 1000))`.
- Recalculates whenever `lastTickAt` changes (from a new API response after a tick or Force Refresh).
- Cleans up interval on unmount.

### Dashboard.tsx

Replace the header row with the countdown text and Force Refresh button together:

```
<header>
  Dashboard
  <right side>
    "Next poll in 23s" | "Polling now..." | "Waiting for first poll..."
    [Force Refresh]
  </right side>
</header>
```

Display states:
- `secondsRemaining === null` → "Waiting for first poll..."
- `secondsRemaining === 0` → "Polling now..."
- `secondsRemaining > 0` → "Next poll in {n}s"

After Force Refresh succeeds, React Query invalidates the state query, which fetches a new response with an updated `last_tick_at`. The countdown hook picks up the new value and resets naturally.

## What this does not include

- No progress bar or circular timer animation — text only.
- No WebSocket integration — rides the existing 3s polling of `/api/v1/state`.
- No config page changes — `poll_interval_ms` is already displayed there.
- No changes to the issue detail page.

## Files changed

| File | Change |
|------|--------|
| `crates/ensemble-core/src/orchestrator/state.rs` | Add `last_tick_at` field |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Set `last_tick_at` in `handle_tick()` |
| `crates/ensemble-core/src/observability/snapshot.rs` | Add `poll_interval_ms` and `last_tick_at` to `RuntimeSnapshot`, populate in `build_state_snapshot()` |
| `crates/ensemble-ui/src-ui/src/hooks.ts` | Add `useNextPollCountdown` hook |
| `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx` | Show countdown next to Force Refresh |
| Generated TypeScript types | Re-run codegen |

## Testing

- Unit test in `state.rs`: verify `last_tick_at` initializes as `None`.
- Unit test in `snapshot.rs`: verify `build_state_snapshot` includes `poll_interval_ms` and `last_tick_at` in output JSON.
- Existing handler tests: update `test_get_state_returns_json` to assert the new fields are present.
- Manual: start `ensemble web`, observe the countdown ticking down, click Force Refresh, confirm it resets.
