# Poll Countdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a countdown on the dashboard indicating when the next backend orchestrator poll will fire.

**Architecture:** Add `last_tick_at` to `OrchestratorState`, surface it plus `poll_interval_ms` in the `RuntimeSnapshot` API response, then consume both on the frontend with a `useNextPollCountdown` hook that ticks down every second and renders next to the Force Refresh button.

**Tech Stack:** Rust (chrono, serde, utoipa), React (TanStack React Query, useState/useEffect), Orval codegen

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/ensemble-core/src/orchestrator/state.rs` | Modify | Add `last_tick_at` field to `OrchestratorState` |
| `crates/ensemble-core/src/orchestrator/mod.rs` | Modify | Set `last_tick_at` at start of `handle_tick()` |
| `crates/ensemble-core/src/observability/snapshot.rs` | Modify | Add `poll_interval_ms` and `last_tick_at` to `RuntimeSnapshot` |
| `crates/ensemble-core/src/api/handlers.rs` | Modify | Update existing test assertions |
| `crates/ensemble-ui/src-ui/src/hooks.ts` | Modify | Add `useNextPollCountdown` hook |
| `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx` | Modify | Display countdown next to Force Refresh |
| `crates/ensemble-ui/src-ui/src/generated/` | Regenerate | Run codegen to pick up new API fields |

---

### Task 1: Add `last_tick_at` to OrchestratorState

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/state.rs:20-54`

- [ ] **Step 1: Write the failing test**

Add to the existing `test_new_state` test in `crates/ensemble-core/src/orchestrator/state.rs`:

```rust
// In the existing test_new_state test (line 274), add after line 283:
assert!(state.last_tick_at.is_none());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p ensemble-core state::tests::test_new_state`
Expected: FAIL — `OrchestratorState` has no field `last_tick_at`.

- [ ] **Step 3: Add the field and initialize it**

In `crates/ensemble-core/src/orchestrator/state.rs`, add the field to the struct (after line 38, before the closing `}`):

```rust
    /// Timestamp of the last orchestrator poll tick.
    pub last_tick_at: Option<DateTime<Utc>>,
```

And initialize it as `None` in `OrchestratorState::new()` (after `pipeline_runs: HashMap::new(),` on line 53):

```rust
            last_tick_at: None,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p ensemble-core state::tests::test_new_state`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/state.rs
git commit -m "Add last_tick_at field to OrchestratorState"
```

---

### Task 2: Set `last_tick_at` in `handle_tick()`

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs:158-165`

- [ ] **Step 1: Set `last_tick_at` at the start of `handle_tick()`**

In `crates/ensemble-core/src/orchestrator/mod.rs`, add at the very start of `handle_tick()` (after line 158, before the stall reconciliation on line 159):

```rust
        // Record tick timestamp for poll countdown
        {
            let mut state = self.state.write().await;
            state.last_tick_at = Some(Utc::now());
        }
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p ensemble-core`
Expected: compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/orchestrator/mod.rs
git commit -m "Set last_tick_at at start of handle_tick"
```

---

### Task 3: Add `poll_interval_ms` and `last_tick_at` to RuntimeSnapshot

**Files:**
- Modify: `crates/ensemble-core/src/observability/snapshot.rs:10-17,119-162`

- [ ] **Step 1: Write the failing test**

Add a new test in `crates/ensemble-core/src/observability/snapshot.rs` (in the `mod tests` block):

```rust
    #[test]
    fn test_build_snapshot_poll_fields() {
        let mut state = OrchestratorState::new(30000, 10);
        // No tick yet
        let snapshot = build_state_snapshot(&state);
        assert_eq!(snapshot.poll_interval_ms, 30000);
        assert!(snapshot.last_tick_at.is_none());

        // After a tick
        let tick_time = Utc::now();
        state.last_tick_at = Some(tick_time);
        let snapshot = build_state_snapshot(&state);
        assert_eq!(snapshot.poll_interval_ms, 30000);
        assert_eq!(snapshot.last_tick_at, Some(tick_time));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p ensemble-core snapshot::tests::test_build_snapshot_poll_fields`
Expected: FAIL — `RuntimeSnapshot` has no field `poll_interval_ms`.

- [ ] **Step 3: Add the fields to RuntimeSnapshot**

In `crates/ensemble-core/src/observability/snapshot.rs`, add two fields to `RuntimeSnapshot` (after `rate_limits` on line 16):

```rust
    pub poll_interval_ms: u64,
    pub last_tick_at: Option<DateTime<Utc>>,
```

- [ ] **Step 4: Populate them in `build_state_snapshot()`**

In `build_state_snapshot()`, add the fields to the `RuntimeSnapshot` constructor (after `rate_limits` on line 160):

```rust
        poll_interval_ms: state.poll_interval_ms,
        last_tick_at: state.last_tick_at,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p ensemble-core snapshot::tests::test_build_snapshot_poll_fields`
Expected: PASS

- [ ] **Step 6: Update the JSON shape test**

In the existing `test_build_snapshot_json_shape` test in `snapshot.rs`, add assertions for the new keys (after the `rate_limits` assertion on line 451):

```rust
        assert!(json.get("poll_interval_ms").is_some());
        assert!(json.get("last_tick_at").is_some());
```

- [ ] **Step 7: Update the empty state test**

In the existing `test_build_snapshot_empty_state` test in `snapshot.rs`, add assertions (after `seconds_running` assertion on line 496):

```rust
        assert_eq!(snapshot.poll_interval_ms, 30000);
        assert!(snapshot.last_tick_at.is_none());
```

- [ ] **Step 8: Run all snapshot tests**

Run: `cargo test -p ensemble-core snapshot::tests`
Expected: all PASS

- [ ] **Step 9: Update handler test**

In `crates/ensemble-core/src/api/handlers.rs`, the existing `test_get_state_returns_json` test (line 253) should still pass because the new fields are serialized automatically. Run it to verify:

Run: `cargo test -p ensemble-core api::handlers::tests::test_get_state_returns_json`
Expected: PASS (the test doesn't assert absence of unknown keys)

- [ ] **Step 10: Run full test suite and clippy**

Run: `cargo test --workspace && cargo clippy --workspace -- -D warnings`
Expected: all PASS, no clippy warnings.

- [ ] **Step 11: Commit**

```bash
git add crates/ensemble-core/src/observability/snapshot.rs crates/ensemble-core/src/api/handlers.rs
git commit -m "Add poll_interval_ms and last_tick_at to RuntimeSnapshot"
```

---

### Task 4: Regenerate TypeScript client

**Files:**
- Regenerate: `crates/ensemble-ui/src-ui/src/generated/`

- [ ] **Step 1: Run codegen**

```bash
cd crates/ensemble-ui/src-ui && pnpm run codegen
```

Expected: OpenAPI spec regenerated from Rust types, Orval generates updated TypeScript types. The `RuntimeSnapshot` type in the generated code should now include `poll_interval_ms: number` and `last_tick_at: string | null`.

- [ ] **Step 2: Verify the generated types include the new fields**

Run: `grep -E "poll_interval_ms|last_tick_at" crates/ensemble-ui/src-ui/src/generated/models/*.ts`
Expected: both fields present in the `RuntimeSnapshot` type definition.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/generated/
git commit -m "Regenerate TypeScript client with poll countdown fields"
```

---

### Task 5: Add `useNextPollCountdown` hook

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`

- [ ] **Step 1: Add the countdown hook**

Add the following to `crates/ensemble-ui/src-ui/src/hooks.ts` (after the `useStateQuery` function, before `useIssueDetailQuery`):

```typescript
/**
 * Computes a countdown (in seconds) until the next backend orchestrator poll.
 * Returns null if the orchestrator hasn't ticked yet.
 */
export function useNextPollCountdown(
  lastTickAt: string | null | undefined,
  pollIntervalMs: number | undefined,
): number | null {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!lastTickAt || !pollIntervalMs) {
      setSecondsRemaining(null);
      return;
    }

    const lastTickMs = new Date(lastTickAt).getTime();
    const compute = () => {
      const nextPollMs = lastTickMs + pollIntervalMs;
      const remaining = Math.max(0, Math.ceil((nextPollMs - Date.now()) / 1000));
      setSecondsRemaining(remaining);
    };

    compute();
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [lastTickAt, pollIntervalMs]);

  return secondsRemaining;
}
```

Also add the `useState, useEffect` import at the top of the file:

```typescript
import { useState, useEffect } from "react";
```

- [ ] **Step 2: Verify the frontend builds**

```bash
cd crates/ensemble-ui/src-ui && pnpm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/hooks.ts
git commit -m "Add useNextPollCountdown hook"
```

---

### Task 6: Display countdown on Dashboard

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Update the Dashboard component**

Replace the header section of `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`. The current header (lines 29-37) is:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? "Refreshing..." : "Force Refresh"}
        </Button>
      </div>
```

Replace it with:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {pollCountdown === null
              ? "Waiting for first poll..."
              : pollCountdown === 0
                ? "Polling now..."
                : `Next poll in ${pollCountdown}s`}
          </span>
          <Button
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
          >
            {refreshMutation.isPending ? "Refreshing..." : "Force Refresh"}
          </Button>
        </div>
      </div>
```

- [ ] **Step 2: Add the hook call**

Add the import and hook call. Update the import line at the top of `Dashboard.tsx` (line 1):

```typescript
import { useStateQuery, useRefreshMutation, useRetryMutation, useNextPollCountdown } from "@/hooks";
```

Add the hook call inside the `Dashboard` component, after the existing hook calls (after line 11):

```typescript
  const pollCountdown = useNextPollCountdown(data?.last_tick_at ?? null, data?.poll_interval_ms);
```

- [ ] **Step 3: Verify the frontend builds**

```bash
cd crates/ensemble-ui/src-ui && pnpm run build
```

Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx
git commit -m "Show poll countdown on dashboard"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run Rust tests and clippy**

```bash
cargo test --workspace && cargo clippy --workspace -- -D warnings
```

Expected: all PASS, no warnings.

- [ ] **Step 2: Run frontend build and type check**

```bash
cd crates/ensemble-ui/src-ui && pnpm run build
```

Expected: build succeeds.

- [ ] **Step 3: Check formatting**

```bash
cargo fmt --all -- --check
```

Expected: no formatting issues.
