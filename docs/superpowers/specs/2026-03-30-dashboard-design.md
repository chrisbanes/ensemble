# Ensemble Dashboard — Design Spec

Supersedes Plan 5 (Desktop & Dashboard). Defines a React dashboard for inspecting and controlling agent runs, shipped as a Tauri desktop app and optionally served from the CLI.

## Decisions

| Topic | Decision |
|---|---|
| Agent inspection depth | Event timeline + full conversation drill-down |
| Operator controls | Defensive only — stop, force-retry, refresh |
| Historical runs | Append-only JSONL log file on disk |
| Notifications | In-app panel + browser Notification API |
| Dark mode | Light/dark toggle with `prefers-color-scheme` detection |
| Live streaming | WebSocket for active issue detail view, REST polling elsewhere |
| Conversation data | Paginated via REST (cursor-based), not streamed |

## Architecture

```
┌─────────────────────────────────┐       ┌──────────────────────────────────────┐
│  Browser / Tauri WebView        │       │  axum HTTP Server (ensemble-core)    │
│                                 │       │                                      │
│  Dashboard ──── GET /state ─────┼──REST──►  REST API /api/v1/*                │
│  (polls 3s)                     │       │    GET  /state                       │
│                                 │       │    GET  /{id}                        │
│  Issue Detail ── WS /events/{id}┼──WS───►    GET  /{id}/conversation          │
│  (live events)                  │       │    GET  /history                     │
│  (conversation via REST)        │       │    GET  /config                      │
│                                 │       │    POST /refresh                     │
│  History ──── GET /history ─────┼──REST──►    POST /{id}/stop                 │
│  Config  ──── GET /config ──────┼──REST──►    POST /{id}/retry                │
│                                 │       │                                      │
│  Notifications (in-app +        │       │  WebSocket /ws/events/{id}           │
│  browser Notification API)      │       │    snapshot on connect               │
│                                 │       │    typed events streamed             │
│  Dark mode toggle               │       │                                      │
└─────────────────────────────────┘       │  ┌────────────┐ ┌──────┐ ┌────────┐ │
                                          │  │Orchestrator│ │JSONL │ │Event   │ │
                                          │  │State       │ │History│ │Bus     │ │
                                          │  │Arc<RwLock> │ │File  │ │broadcast│ │
                                          │  └────────────┘ └──────┘ └────────┘ │
                                          └──────────────────────────────────────┘
```

### Two data paths

- **Event stream (WebSocket)** — lightweight typed events pushed to the client for the active issue detail view. One WebSocket connection per open detail page. Events are small (step transitions, summarized tool calls, verdicts, errors). The server sends a snapshot message on connect, then streams events as they occur. The connection auto-closes when the run completes.
- **Conversation (REST)** — paginated retrieval of the full agent conversation. `GET /api/v1/{id}/conversation?cursor=X&limit=50` returns pages of messages (system, assistant, tool calls with results). Loaded on demand as the user scrolls. Events in the timeline link to specific conversation offsets for cross-referencing.

### Backend stores

- **Orchestrator state** — `Arc<RwLock<OrchestratorState>>`, existing. Read by snapshot endpoints.
- **History log** — append-only JSONL file. Each line is a completed run record (issue ID, outcome, steps traversed, attempt count, token totals, duration, timestamps, last error). Written when a pipeline completes or exhausts retries. Read and filtered by `GET /api/v1/history`.
- **Event bus** — `tokio::sync::broadcast` channel. The orchestrator publishes typed events as they occur. WebSocket handlers subscribe per-issue and forward matching events to connected clients.

### Tech stack

Same as original Plan 5: React 19, TypeScript, Vite, Tailwind CSS, TanStack Query, React Router, Tauri 2, tower-http (ServeDir). Additional: `tokio-tungstenite` for WebSocket support in axum.

## API Endpoints

### Existing (from Plan 4)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/state` | Runtime state snapshot (running sessions, retry queue, agent totals, rate limits) |
| GET | `/api/v1/{identifier}` | Issue-specific detail (status, workspace, attempts, running/retry info, last error) |
| POST | `/api/v1/refresh` | Trigger immediate tracker poll + reconciliation |

### New

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/{identifier}/conversation` | Paginated agent conversation messages |
| GET | `/api/v1/{identifier}/conversation/{index}` | Single message with full tool output |
| GET | `/api/v1/history` | Completed run records from JSONL log |
| GET | `/api/v1/config` | Effective configuration + validation state |
| POST | `/api/v1/{identifier}/stop` | Stop a running agent (defensive control) |
| POST | `/api/v1/{identifier}/retry` | Force-retry a failed/retrying issue (defensive control) |
| WS | `/ws/events/{identifier}` | Live event stream for a specific issue |

### GET /api/v1/{identifier}/conversation

Returns paginated agent conversation messages for an issue.

**Query parameters:**
- `cursor` (string, optional) — opaque cursor for pagination. Omit for the most recent page.
- `limit` (integer, optional, default 50) — number of messages per page.
- `direction` (string, optional, default "backward") — `"backward"` for older messages, `"forward"` for newer.

**Response:**
```json
{
  "issue_identifier": "MT-649",
  "messages": [
    {
      "index": 142,
      "role": "assistant",
      "turn": 12,
      "content": "Now let me write tests to verify the middleware works correctly...",
      "timestamp": "2026-02-24T20:14:22Z",
      "tokens": { "input": 0, "output": 84 }
    },
    {
      "index": 143,
      "role": "tool_call",
      "turn": 12,
      "tool_name": "write",
      "tool_input_summary": "src/auth/tests.rs (new file, 67 lines)",
      "tool_result_summary": "File written successfully",
      "tool_result_lines": 67,
      "timestamp": "2026-02-24T20:14:30Z"
    },
    {
      "index": 144,
      "role": "tool_call",
      "turn": 12,
      "tool_name": "bash",
      "tool_input_summary": "cargo test --lib auth",
      "tool_result_summary": null,
      "status": "running",
      "timestamp": "2026-02-24T20:14:45Z"
    }
  ],
  "pagination": {
    "has_more": true,
    "next_cursor": "eyJ0IjoxNDJ9",
    "prev_cursor": null
  }
}
```

Tool call messages include summarized input/output to keep payloads small. Tool results under 500 characters are inlined in `tool_result_summary`. Larger results are truncated with a line count; the client can fetch full results via `GET /api/v1/{identifier}/conversation/{index}` which returns the single message with complete tool output.

### GET /api/v1/history

Returns completed run records from the JSONL history log.

**Query parameters:**
- `cursor` (string, optional) — opaque cursor for pagination.
- `limit` (integer, optional, default 20) — records per page.
- `outcome` (string, optional) — filter: `"succeeded"`, `"failed"`, `"max_retries"`.
- `issue` (string, optional) — filter by issue identifier substring (case-insensitive).
- `since` (string, optional) — ISO 8601 timestamp, only return records completed after this time.
- `step` (string, optional) — filter to runs that executed this pipeline step.

**Response:**
```json
{
  "records": [
    {
      "issue_identifier": "MT-648",
      "issue_id": "abc123",
      "outcome": "succeeded",
      "steps_traversed": ["build", "review"],
      "attempts": 1,
      "tokens": {
        "input_tokens": 180000,
        "output_tokens": 104000,
        "total_tokens": 284000
      },
      "duration_seconds": 765,
      "started_at": "2026-02-24T19:29:00Z",
      "completed_at": "2026-02-24T19:41:45Z",
      "last_error": null,
      "verdict": "approved"
    }
  ],
  "pagination": {
    "has_more": true,
    "next_cursor": "eyJ0IjoiMjAyNi0wMi0yNFQxOToyOTowMFoifQ"
  }
}
```

### GET /api/v1/config

Returns the effective configuration and its validation state.

**Response:**
```json
{
  "valid": true,
  "errors": [],
  "config_path": "/home/user/project/ensemble.yaml",
  "agents": [
    {
      "name": "claude-code",
      "command": "claude --agent",
      "model": "opus-4",
      "max_turns": 200
    }
  ],
  "pipeline": {
    "steps": [
      { "name": "build", "agent": "claude-code", "depends": [] },
      { "name": "review", "agent": "reviewer", "depends": ["build"] }
    ]
  },
  "runtime": {
    "max_concurrent": 4,
    "max_retries": 5,
    "poll_interval_seconds": 60,
    "workspace_root": "/tmp/ensemble_workspaces",
    "tracker": "github_projects",
    "server_port": 9131
  }
}
```

### POST /api/v1/{identifier}/stop

Stops a running agent for the specified issue. The orchestrator sends a termination signal to the agent process and marks the issue for potential retry or failure depending on configuration.

**Response (200):**
```json
{
  "stopped": true,
  "issue_identifier": "MT-649",
  "message": "Agent process terminated"
}
```

**Response (404):** Issue not found or not currently running.

**Response (409):** Issue is not in a stoppable state (e.g., already completed).

### POST /api/v1/{identifier}/retry

Forces an immediate retry for an issue in the retry queue or in a failed state. Bypasses the normal backoff timer.

**Response (200):**
```json
{
  "retrying": true,
  "issue_identifier": "MT-650",
  "attempt": 4,
  "message": "Retry queued immediately"
}
```

**Response (404):** Issue not found.

**Response (409):** Issue is not in a retryable state (e.g., currently running, or max retries exhausted).

### WebSocket /ws/events/{identifier}

Opens a persistent connection for live event streaming on a specific issue.

**Connection flow:**
1. Client connects to `/ws/events/MT-649`
2. Server sends a `snapshot` message with current issue state
3. Server streams typed `event` messages as they occur
4. Connection closes when the run completes (server sends a `complete` message first)
5. On reconnect, server sends a fresh snapshot

**Message format (server → client):**

Snapshot (sent on connect):
```json
{
  "type": "snapshot",
  "issue_identifier": "MT-649",
  "status": "running",
  "step_name": "build",
  "turn_count": 12,
  "tokens": { "input_tokens": 120000, "output_tokens": 22000, "total_tokens": 142000 },
  "started_at": "2026-02-24T20:10:12Z",
  "events": [
    { "type": "session_started", "timestamp": "2026-02-24T20:10:10Z", "detail": "Workspace created" },
    { "type": "step_started", "timestamp": "2026-02-24T20:10:12Z", "detail": "Pipeline step \"build\" started" }
  ]
}
```

The `events` array in the snapshot contains recent events (last N, configurable) so the client can populate the timeline immediately without a separate request.

Event (streamed):
```json
{
  "type": "event",
  "event_type": "turn_completed",
  "timestamp": "2026-02-24T20:14:59Z",
  "turn": 12,
  "detail": "Agent wrote tests for auth module",
  "conversation_index": 142,
  "tokens_delta": { "input": 3200, "output": 1800 }
}
```

Event types:
- `session_started` — workspace created, agent process launched
- `step_started` — pipeline step began executing
- `step_completed` — pipeline step finished (includes verdict if review step)
- `turn_completed` — agent completed a turn (includes summarized activity)
- `tool_call` — agent invoked a tool (name + summarized input)
- `error` — agent or hook error occurred
- `retry_scheduled` — issue moved to retry queue
- `complete` — pipeline finished (succeeded, failed, or max retries). Connection closes after this.

Complete (sent before close):
```json
{
  "type": "complete",
  "outcome": "succeeded",
  "timestamp": "2026-02-24T20:22:00Z"
}
```

## Pages

### Dashboard (`/`)

The main operational overview. Polls `GET /api/v1/state` every 3 seconds.

**Layout:**
- Nav bar: Ensemble logo, Dashboard / History / Config tabs, notification bell (with unread badge count), dark mode toggle (moon/sun icon)
- Header row: "Dashboard" title with last-updated timestamp, "Force Refresh" button
- Stats cards row (5 cards): Running count, Retrying count, Input Tokens, Output Tokens, Total Runtime
- Running Agents table: Issue (clickable link to detail), Step, Turns, Last Event, Tokens, Runtime, Status badge
- Retry Queue table: Issue (clickable link), Attempt (X / max), Retry In (countdown), Error (truncated), Actions ("Retry Now" button)

**Behavior:**
- Issue IDs in both tables link to `/issue/{identifier}`
- "Force Refresh" calls `POST /api/v1/refresh` and invalidates the state query
- "Retry Now" calls `POST /api/v1/{identifier}/retry` and invalidates the state query
- Stats cards update on each poll cycle
- Empty states: "No agents currently running" / "Retry queue is empty"

### Issue Detail (`/issue/:identifier`)

The agent inspection view. Two-column layout with event timeline and conversation viewer.

**Header:**
- Back link to Dashboard
- Issue identifier (large), status badge, current pipeline step badge, WebSocket connection indicator
- "Stop Agent" button (red, only shown for running issues)

**Stats cards row (4 cards):** Turns, Tokens, Runtime, Attempt (X / max)

**Left column — Event Timeline:**
- Live-updating via WebSocket (`/ws/events/{identifier}`)
- Reverse-chronological list of typed events
- Color-coded dots: green (turn completed), purple (tool call), blue (step transition), gray (lifecycle)
- Each turn-completion event includes a "View in conversation" link that scrolls/pages the right panel to the relevant turn
- "live" indicator when WebSocket is connected
- For historical runs (from History page): static list, no WebSocket, no controls

**Right column — Conversation Viewer:**
- Paginated via `GET /api/v1/{identifier}/conversation`
- Message types with distinct styling:
  - System/prompt: green background, shows prompt text (truncated with token count)
  - Assistant: default background, shows message text with turn number
  - Tool call: purple background, shows tool name + summarized input. Collapsible detail section for tool result
  - Running tool: shows spinner indicator
- Cursor-based pagination footer: "Older" / "Newer" buttons with "Showing turns X-Y of Z"
- Clicking "View in conversation" from the event timeline navigates to the correct page and scrolls to the relevant message

**Workspace info bar:** Filesystem path, restart count, start time.

**Controls:**
- "Stop Agent" button: calls `POST /api/v1/{identifier}/stop`, shows confirmation dialog first
- For retrying issues: "Retry Now" button instead of Stop
- For historical runs: no control buttons shown

### History (`/history`)

Browse and filter completed runs. Data from `GET /api/v1/history`.

**Layout:**
- Header: "History" title with total record count
- Filter bar: search by issue ID (text input), outcome filter (all/succeeded/failed/max retries), time range filter (all time/last 24h/7 days/30 days), pipeline step filter
- Results table: Issue (clickable), Outcome badge, Steps traversed (visual flow: build -> review), Attempts, Tokens, Duration, Completed timestamp
- Cursor-based pagination footer

**Behavior:**
- Clicking a row opens `/issue/{identifier}` in read-only historical mode
- Filters update the query parameters on `GET /api/v1/history` and reset pagination
- Client-side filtering for small result sets, server-side for larger ones

### Config Status (`/config`)

Displays effective configuration and validation state. Data from `GET /api/v1/config`.

**Layout:**
- Validation banner: green checkmark + "Configuration is valid" (or red with error messages if invalid)
- Agents table: Name, Command, Model, Max Turns
- Pipeline Steps: visual flow diagram showing the step DAG with agent assignments
- Runtime Settings grid: Max Concurrent, Max Retries, Poll Interval, Workspace Root, Tracker type, Server Port

**Behavior:**
- Read-only view, no editing from the dashboard
- Fetched once on page load (no polling — config rarely changes)

## Notifications

### In-app panel

A dropdown panel anchored to the bell icon in the nav bar.

**Notification types:**
- **Failure** (red dot): Agent failed after max retries. Triggers browser notification.
- **Warning** (amber dot): Entered retry queue, rate limit approaching, agent stall detected. Triggers browser notification.
- **Success** (no dot): Pipeline completed successfully. In-app only.
- **Info** (no dot): Step transitions, config reload. In-app only, low priority.

**Panel layout:**
- Header: "Notifications" title + "Mark all read" link
- List of notifications, newest first
- Unread notifications have a highlighted background
- Each notification: severity dot, title, detail text, timestamp
- Clicking a notification navigates to the relevant issue detail

**State:** Notifications are stored in-memory on the client (TanStack Query cache or React state). They are populated from:
1. Events received via WebSocket (if an issue detail page is open)
2. Polling diffs on the state endpoint (detect new failures, retries, completions between polls)

Notifications do not persist across page reloads — they represent the current session's activity.

### Browser notifications

Uses the browser Notification API (requires user permission grant).

**Triggers:**
- Agent failure after max retries
- Issue entered retry queue (warning)

**Behavior:**
- Only fires when the dashboard tab is not focused
- Clicking the browser notification focuses the dashboard and navigates to the relevant issue
- Permission is requested on first triggering event, not on page load

## Dark Mode

**Implementation:** Tailwind CSS `darkMode: 'class'` strategy.

**Behavior:**
- On first load, reads `prefers-color-scheme` media query and applies matching theme
- Toggle in nav bar (moon/sun icon) overrides the system preference
- Preference stored in `localStorage` under key `ensemble-theme`
- Toggle adds/removes `dark` class on `<html>` element

## History Log Format

Append-only JSONL file at a configurable path (default: `{workspace_root}/.ensemble_history.jsonl`).

Each line is a JSON object representing a completed run:

```json
{
  "issue_identifier": "MT-648",
  "issue_id": "abc123",
  "outcome": "succeeded",
  "steps_traversed": ["build", "review"],
  "attempts": 1,
  "tokens": {
    "input_tokens": 180000,
    "output_tokens": 104000,
    "total_tokens": 284000
  },
  "duration_seconds": 765,
  "started_at": "2026-02-24T19:29:00Z",
  "completed_at": "2026-02-24T19:41:45Z",
  "last_error": null,
  "verdict": "approved",
  "workspace_path": "/tmp/ensemble_workspaces/MT-648"
}
```

The file is appended to atomically (write + rename or append with newline). The `GET /api/v1/history` endpoint reads this file, applies filters, and returns paginated results. For the initial implementation, the file is read in full and filtered in memory. If log files grow large, a future optimization can index or rotate them.

The `workspace_path` field allows the history endpoint to locate conversation data for historical drill-down, since conversation logs are stored in the workspace directory.

## File Structure

```
ensemble/
├── crates/
│   ├── ensemble-core/
│   │   ├── Cargo.toml                          # add: tower-http, tokio-tungstenite
│   │   └── src/
│   │       ├── api/
│   │       │   ├── router.rs                   # updated: new endpoints + static serving
│   │       │   ├── ws.rs                       # new: WebSocket handler
│   │       │   └── history.rs                  # new: JSONL history reader + filter
│   │       └── observability/
│   │           └── events.rs                   # new: event bus (broadcast channel)
│   └── ensemble-desktop/
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── build.rs
│       ├── icons/
│       │   └── icon.png
│       ├── src/
│       │   └── main.rs                         # Tauri entry: core + server + webview
│       └── src-ui/
│           ├── package.json
│           ├── tsconfig.json
│           ├── vite.config.ts
│           ├── tailwind.config.js
│           ├── postcss.config.js
│           ├── index.html
│           └── src/
│               ├── main.tsx
│               ├── App.tsx
│               ├── index.css
│               ├── types.ts                    # API + WebSocket message types
│               ├── api.ts                      # REST fetch + TanStack Query hooks
│               ├── ws.ts                       # WebSocket client + reconnection
│               ├── notifications.ts            # notification state + browser API
│               ├── theme.ts                    # dark mode toggle + localStorage
│               ├── pages/
│               │   ├── Dashboard.tsx
│               │   ├── IssueDetail.tsx
│               │   ├── History.tsx
│               │   └── ConfigStatus.tsx
│               └── components/
│                   ├── Layout.tsx              # nav bar + notification bell + theme toggle
│                   ├── RunningTable.tsx
│                   ├── RetryQueue.tsx
│                   ├── AgentTotals.tsx
│                   ├── StatusBadge.tsx
│                   ├── EventTimeline.tsx        # new: live event list
│                   ├── ConversationViewer.tsx   # new: paginated message list
│                   ├── NotificationPanel.tsx    # new: dropdown panel
│                   └── ConfirmDialog.tsx        # new: confirmation for stop/retry
```

## Non-goals

- Rich text editing or issue creation from the dashboard
- Multi-tenant or multi-instance support
- Agent log file tailing (conversation viewer replaces this)
- Persistent notification storage (session-only)
- Config editing from the UI
- WebSocket for the dashboard overview (REST polling is sufficient)
