# Plan 5: Dashboard — React Frontend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React dashboard that consumes the ensemble backend API (from Plan 4) for inspecting and controlling agent runs, served as static assets from the CLI's axum server.

**Architecture:** Vite + React 19 SPA that polls REST for dashboard overview data and opens a WebSocket for live issue detail. All backend endpoints (including event streaming, history, conversation, stop/retry, and static asset serving) are provided by Plan 4.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS, TanStack Query, React Router

**Depends on:** Plan 4 (API, Observability, CLI & Backend Extensions) must be implemented first. All REST and WebSocket endpoints are available.

**Supersedes:** Plan 5 (2026-03-29-plan-5-desktop-dashboard.md)

**Design spec:** `docs/superpowers/specs/2026-03-30-dashboard-design.md`

---

## File Structure

```
ensemble/
├── crates/
│   └── ensemble-desktop/
│       └── src-ui/
│           ├── package.json
│           ├── tsconfig.json
│           ├── tsconfig.node.json
│           ├── vite.config.ts
│           ├── tailwind.config.js
│           ├── postcss.config.js
│           ├── index.html
│           └── src/
│               ├── main.tsx
│               ├── App.tsx
│               ├── index.css
│               ├── types.ts
│               ├── api.ts
│               ├── ws.ts
│               ├── notifications.ts
│               ├── theme.ts
│               ├── pages/
│               │   ├── Dashboard.tsx
│               │   ├── IssueDetail.tsx
│               │   ├── History.tsx
│               │   └── ConfigStatus.tsx
│               └── components/
│                   ├── Layout.tsx
│                   ├── RunningTable.tsx
│                   ├── RetryQueue.tsx
│                   ├── AgentTotals.tsx
│                   ├── StatusBadge.tsx
│                   ├── EventTimeline.tsx
│                   ├── ConversationViewer.tsx
│                   ├── NotificationPanel.tsx
│                   └── ConfirmDialog.tsx
```

NOTE: Backend tasks (event bus, history log, new API endpoints, WebSocket handler, static asset serving) have been folded into Plan 4 (Tasks 7-12). Tauri desktop wrapper is in Plan 6. This plan covers only the React frontend.

---

## Phase 1: Frontend Scaffolding

### Task 1: React Project Scaffolding

**Files:**
- Create: `crates/ensemble-desktop/src-ui/package.json`
- Create: `crates/ensemble-desktop/src-ui/tsconfig.json`
- Create: `crates/ensemble-desktop/src-ui/tsconfig.node.json`
- Create: `crates/ensemble-desktop/src-ui/vite.config.ts`
- Create: `crates/ensemble-desktop/src-ui/tailwind.config.js`
- Create: `crates/ensemble-desktop/src-ui/postcss.config.js`
- Create: `crates/ensemble-desktop/src-ui/index.html`
- Create: `crates/ensemble-desktop/src-ui/src/main.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/index.css`
- Create: `crates/ensemble-desktop/src-ui/src/App.tsx`

- [ ] **Step 1: Create package.json**

`crates/ensemble-desktop/src-ui/package.json`:
```json
{
  "name": "ensemble-dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.0",
    "@tanstack/react-query": "^5.62.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

`crates/ensemble-desktop/src-ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create tsconfig.node.json**

`crates/ensemble-desktop/src-ui/tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Create vite.config.ts**

`crates/ensemble-desktop/src-ui/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:9131",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:9131",
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 5: Create tailwind.config.js**

`crates/ensemble-desktop/src-ui/tailwind.config.js`:
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {},
  },
  plugins: [],
};
```

- [ ] **Step 6: Create postcss.config.js**

`crates/ensemble-desktop/src-ui/postcss.config.js`:
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 7: Create index.html**

`crates/ensemble-desktop/src-ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ensemble Dashboard</title>
    <script>
      // Apply theme before render to avoid flash.
      (function () {
        const stored = localStorage.getItem("ensemble-theme");
        if (stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
          document.documentElement.classList.add("dark");
        }
      })();
    </script>
  </head>
  <body class="bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 min-h-screen">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Create index.css**

`crates/ensemble-desktop/src-ui/src/index.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, sans-serif;
}
```

- [ ] **Step 9: Create main.tsx**

`crates/ensemble-desktop/src-ui/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      retry: 1,
      staleTime: 2000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 10: Create App.tsx**

`crates/ensemble-desktop/src-ui/src/App.tsx`:
```tsx
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import IssueDetail from "./pages/IssueDetail";
import History from "./pages/History";
import ConfigStatus from "./pages/ConfigStatus";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/issue/:identifier" element={<IssueDetail />} />
        <Route path="/history" element={<History />} />
        <Route path="/config" element={<ConfigStatus />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
```

- [ ] **Step 11: Install dependencies**

Run: `npm --prefix crates/ensemble-desktop/src-ui install`
Expected: `node_modules` created, no errors.

- [ ] **Step 12: Commit**

```bash
git add crates/ensemble-desktop/src-ui/package.json crates/ensemble-desktop/src-ui/package-lock.json crates/ensemble-desktop/src-ui/tsconfig.json crates/ensemble-desktop/src-ui/tsconfig.node.json crates/ensemble-desktop/src-ui/vite.config.ts crates/ensemble-desktop/src-ui/tailwind.config.js crates/ensemble-desktop/src-ui/postcss.config.js crates/ensemble-desktop/src-ui/index.html crates/ensemble-desktop/src-ui/src/main.tsx crates/ensemble-desktop/src-ui/src/index.css crates/ensemble-desktop/src-ui/src/App.tsx
git commit -m "scaffold: React + Vite + Tailwind project with dark mode and WebSocket proxy"
```

---

### Task 2: TypeScript Types

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/types.ts`

- [ ] **Step 1: Define all API and WebSocket types**

`crates/ensemble-desktop/src-ui/src/types.ts`:
```typescript
// --- REST API types ---

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunningSession {
  issue_id: string;
  issue_identifier: string;
  state: string;
  step_name: string | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: TokenCounts;
}

export interface RetryEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at_ms: number;
  error: string | null;
}

export interface AgentTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface RateLimitSnapshot {
  remaining: number;
  limit: number;
  reset_at: string | null;
}

export interface StateResponse {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningSession[];
  retrying: RetryEntry[];
  agent_totals: AgentTotals;
  rate_limits: RateLimitSnapshot | null;
}

export interface IssueDetailResponse {
  issue_identifier: string;
  issue_id: string;
  status: string;
  workspace: { path: string };
  attempts: {
    restart_count: number;
    current_retry_attempt: number | null;
  };
  running: {
    session_id: string | null;
    step_name: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_message: string | null;
    last_event_at: string | null;
    tokens: TokenCounts;
  } | null;
  retry: {
    attempt: number;
    due_at: string;
    error: string | null;
  } | null;
  last_error: string | null;
}

export interface RefreshResponse {
  queued: boolean;
  coalesced: boolean;
  requested_at: string;
  operations: string[];
}

export interface StopResponse {
  stopped: boolean;
  issue_identifier: string;
  message: string;
}

export interface RetryResponse {
  retrying: boolean;
  issue_identifier: string;
  attempt: number;
  message: string;
}

// --- Conversation types ---

export type ConversationMessage =
  | {
      role: "system";
      index: number;
      turn: number;
      content: string;
      timestamp: string;
    }
  | {
      role: "assistant";
      index: number;
      turn: number;
      content: string;
      timestamp: string;
      tokens: { input: number; output: number };
    }
  | {
      role: "tool_call";
      index: number;
      turn: number;
      tool_name: string;
      tool_input_summary: string;
      tool_result_summary: string | null;
      tool_result_lines: number | null;
      timestamp: string;
      status?: string;
    };

export interface ConversationResponse {
  issue_identifier: string;
  messages: ConversationMessage[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
    prev_cursor: string | null;
  };
}

// --- History types ---

export interface HistoryRecord {
  issue_identifier: string;
  issue_id: string;
  outcome: string;
  steps_traversed: string[];
  attempts: number;
  tokens: TokenCounts;
  duration_seconds: number;
  started_at: string;
  completed_at: string;
  last_error: string | null;
  verdict: string | null;
}

export interface HistoryResponse {
  records: HistoryRecord[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

// --- Config types ---

export interface ConfigResponse {
  valid: boolean;
  errors: string[];
  config_path: string;
  agents: Array<{
    name: string;
    command: string;
    model: string;
    max_turns: number;
  }>;
  pipeline: {
    steps: Array<{
      name: string;
      agent: string;
      depends: string[];
    }>;
  };
  runtime: {
    max_concurrent: number;
    max_retries: number;
    poll_interval_seconds: number;
    workspace_root: string;
    tracker: string;
    server_port: number;
  };
}

// --- WebSocket types ---

export interface WsSnapshot {
  type: "snapshot";
  issue_identifier: string;
  status: string;
  step_name: string | null;
  turn_count: number;
  tokens: TokenCounts;
  started_at: string;
  events: WsEventData[];
}

export interface WsEventMessage {
  type: "event";
  event_type: string;
  timestamp: string;
  turn?: number;
  detail: string;
  conversation_index?: number;
  tokens_delta?: { input: number; output: number };
  step_name?: string;
  tool_name?: string;
  attempt?: number;
  verdict?: string;
  outcome?: string;
}

export interface WsComplete {
  type: "complete";
  outcome: string;
  timestamp: string;
}

export type WsMessage = WsSnapshot | WsEventMessage | WsComplete;

export interface WsEventData {
  type: string;
  timestamp: string;
  detail: string;
  [key: string]: unknown;
}

// --- Notification types ---

export type NotificationSeverity = "failure" | "warning" | "success" | "info";

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  timestamp: string;
  issue_identifier: string;
  read: boolean;
}

// --- API error ---

export interface ApiError {
  error: { code: string; message: string };
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/types.ts
git commit -m "feat: TypeScript types for REST, WebSocket, conversation, history, and notifications"
```

---

### Task 3: API Fetch Layer and TanStack Query Hooks

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/api.ts`

- [ ] **Step 1: Write API functions and query hooks**

`crates/ensemble-desktop/src-ui/src/api.ts`:
```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  StateResponse,
  IssueDetailResponse,
  RefreshResponse,
  StopResponse,
  RetryResponse,
  ConversationResponse,
  HistoryResponse,
  ConfigResponse,
  ApiError,
} from "./types";

const API_BASE = "/api/v1";

class FetchError extends Error {
  status: number;
  body: ApiError | null;

  constructor(status: number, body: ApiError | null) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.name = "FetchError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    ...init,
  });

  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      // response was not JSON
    }
    throw new FetchError(res.status, body);
  }

  return res.json() as Promise<T>;
}

// --- Fetch functions ---

export function fetchState(): Promise<StateResponse> {
  return apiFetch<StateResponse>("/state");
}

export function fetchIssueDetail(identifier: string): Promise<IssueDetailResponse> {
  return apiFetch<IssueDetailResponse>(`/${encodeURIComponent(identifier)}`);
}

export function fetchConversation(
  identifier: string,
  cursor?: string,
  limit = 50,
  direction = "backward",
): Promise<ConversationResponse> {
  const params = new URLSearchParams({ limit: String(limit), direction });
  if (cursor) params.set("cursor", cursor);
  return apiFetch<ConversationResponse>(
    `/${encodeURIComponent(identifier)}/conversation?${params}`,
  );
}

export function fetchHistory(params: {
  cursor?: string;
  limit?: number;
  outcome?: string;
  issue?: string;
  since?: string;
  step?: string;
}): Promise<HistoryResponse> {
  const searchParams = new URLSearchParams();
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.outcome) searchParams.set("outcome", params.outcome);
  if (params.issue) searchParams.set("issue", params.issue);
  if (params.since) searchParams.set("since", params.since);
  if (params.step) searchParams.set("step", params.step);
  return apiFetch<HistoryResponse>(`/history?${searchParams}`);
}

export function fetchConfig(): Promise<ConfigResponse> {
  return apiFetch<ConfigResponse>("/config");
}

export function triggerRefresh(): Promise<RefreshResponse> {
  return apiFetch<RefreshResponse>("/refresh", { method: "POST" });
}

export function stopAgent(identifier: string): Promise<StopResponse> {
  return apiFetch<StopResponse>(`/${encodeURIComponent(identifier)}/stop`, {
    method: "POST",
  });
}

export function retryAgent(identifier: string): Promise<RetryResponse> {
  return apiFetch<RetryResponse>(`/${encodeURIComponent(identifier)}/retry`, {
    method: "POST",
  });
}

// --- TanStack Query hooks ---

export function useStateQuery() {
  return useQuery<StateResponse, FetchError>({
    queryKey: ["state"],
    queryFn: fetchState,
    refetchInterval: 3000,
  });
}

export function useIssueDetailQuery(identifier: string) {
  return useQuery<IssueDetailResponse, FetchError>({
    queryKey: ["issue", identifier],
    queryFn: () => fetchIssueDetail(identifier),
    refetchInterval: 2000,
    enabled: identifier.length > 0,
  });
}

export function useConversationQuery(
  identifier: string,
  cursor?: string,
  direction?: string,
) {
  return useQuery<ConversationResponse, FetchError>({
    queryKey: ["conversation", identifier, cursor, direction],
    queryFn: () => fetchConversation(identifier, cursor, 50, direction),
    enabled: identifier.length > 0,
  });
}

export function useHistoryQuery(params: {
  cursor?: string;
  limit?: number;
  outcome?: string;
  issue?: string;
  since?: string;
  step?: string;
}) {
  return useQuery<HistoryResponse, FetchError>({
    queryKey: ["history", params],
    queryFn: () => fetchHistory(params),
  });
}

export function useConfigQuery() {
  return useQuery<ConfigResponse, FetchError>({
    queryKey: ["config"],
    queryFn: fetchConfig,
    staleTime: 60_000, // Config rarely changes.
  });
}

export function useRefreshMutation() {
  const queryClient = useQueryClient();
  return useMutation<RefreshResponse, FetchError>({
    mutationFn: triggerRefresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}

export function useStopMutation() {
  const queryClient = useQueryClient();
  return useMutation<StopResponse, FetchError, string>({
    mutationFn: stopAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}

export function useRetryMutation() {
  const queryClient = useQueryClient();
  return useMutation<RetryResponse, FetchError, string>({
    mutationFn: retryAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/api.ts
git commit -m "feat: API fetch layer with TanStack Query hooks for all endpoints"
```

---

### Task 4: WebSocket Client

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/ws.ts`

- [ ] **Step 1: Write WebSocket client with reconnection**

`crates/ensemble-desktop/src-ui/src/ws.ts`:
```typescript
import type { WsMessage } from "./types";

export type WsStatus = "connecting" | "connected" | "disconnected";

export interface UseWsOptions {
  identifier: string;
  onMessage: (msg: WsMessage) => void;
  onStatusChange?: (status: WsStatus) => void;
  enabled?: boolean;
}

/**
 * Creates and manages a WebSocket connection for live event streaming.
 * Automatically reconnects with exponential backoff on disconnect.
 * Returns a cleanup function.
 */
export function connectWs(options: UseWsOptions): () => void {
  const { identifier, onMessage, onStatusChange, enabled = true } = options;

  if (!enabled || !identifier) {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;
  let intentionallyClosed = false;

  function connect() {
    onStatusChange?.("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/events/${encodeURIComponent(identifier)}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = 1000;
      onStatusChange?.("connected");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        onMessage(msg);
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      onStatusChange?.("disconnected");
      if (!intentionallyClosed) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
          connect();
        }, reconnectDelay);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    intentionallyClosed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/ws.ts
git commit -m "feat: WebSocket client with auto-reconnect and exponential backoff"
```

---

### Task 5: Theme and Notification Modules

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/theme.ts`
- Create: `crates/ensemble-desktop/src-ui/src/notifications.ts`

- [ ] **Step 1: Create theme module**

`crates/ensemble-desktop/src-ui/src/theme.ts`:
```typescript
const STORAGE_KEY = "ensemble-theme";

export type Theme = "light" | "dark";

export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export function toggleTheme(): Theme {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
```

- [ ] **Step 2: Create notification state module**

`crates/ensemble-desktop/src-ui/src/notifications.ts`:
```typescript
import type { AppNotification, NotificationSeverity } from "./types";

let notifications: AppNotification[] = [];
let listeners: Array<() => void> = [];
let idCounter = 0;

function notify() {
  listeners.forEach((fn) => fn());
}

export function addNotification(
  severity: NotificationSeverity,
  title: string,
  detail: string,
  issue_identifier: string,
): void {
  const notification: AppNotification = {
    id: String(++idCounter),
    severity,
    title,
    detail,
    timestamp: new Date().toISOString(),
    issue_identifier,
    read: false,
  };
  notifications = [notification, ...notifications].slice(0, 100);
  notify();

  // Browser notification for failures and warnings.
  if (
    (severity === "failure" || severity === "warning") &&
    document.hidden &&
    Notification.permission === "granted"
  ) {
    new Notification(title, { body: detail });
  }
}

export function markAllRead(): void {
  notifications = notifications.map((n) => ({ ...n, read: true }));
  notify();
}

export function getNotifications(): AppNotification[] {
  return notifications;
}

export function getUnreadCount(): number {
  return notifications.filter((n) => !n.read).length;
}

export function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** Request browser notification permission on first triggering event. */
export function requestPermissionIfNeeded(): void {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/theme.ts crates/ensemble-desktop/src-ui/src/notifications.ts
git commit -m "feat: dark mode toggle and in-app notification state with browser Notification API"
```

---

## Phase 2: Frontend Pages and Components

**Note:** The remaining tasks (6-11) follow the same pattern — create each component/page file with the exact code from the design spec, then commit. Due to the size of a full React component listing for each file, the remaining tasks provide the component skeleton and key logic. The implementing agent should reference the design spec (`docs/superpowers/specs/2026-03-30-dashboard-design.md`) for exact layout details and the TypeScript types from Task 2 for prop types.

### Task 6: Shared Components — Layout, StatusBadge, ConfirmDialog

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/Layout.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/StatusBadge.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Create Layout component**

`crates/ensemble-desktop/src-ui/src/components/Layout.tsx` — nav bar with Dashboard/History/Config tabs, notification bell with badge, dark mode toggle, and `<Outlet />` for page content. Use `NavLink` from react-router-dom with active class styling. Import `NotificationPanel` (created in Task 11). Import `toggleTheme`/`getTheme` from `../theme`.

Key structure:
```tsx
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { getTheme, toggleTheme } from "../theme";
import NotificationPanel from "./NotificationPanel";
import { getUnreadCount, subscribe } from "../notifications";

export default function Layout() {
  const [theme, setThemeState] = useState(getTheme);
  const [unreadCount, setUnreadCount] = useState(getUnreadCount);
  const [showNotifications, setShowNotifications] = useState(false);

  // Subscribe to notification changes.
  useState(() => {
    return subscribe(() => setUnreadCount(getUnreadCount()));
  });

  // ... render nav bar with links, bell icon, theme toggle, Outlet
}
```

Note: The implementing agent should render a complete nav bar matching the design spec's mockup (dark gray nav, active tab highlighting, bell icon with red badge count, moon/sun toggle).

- [ ] **Step 2: Create StatusBadge component**

`crates/ensemble-desktop/src-ui/src/components/StatusBadge.tsx`:
```tsx
interface StatusBadgeProps {
  status: string;
}

const colorMap: Record<string, string> = {
  running: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  retrying: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  reviewing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  succeeded: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const colors = colorMap[status] ?? "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status}
    </span>
  );
}
```

- [ ] **Step 3: Create ConfirmDialog component**

`crates/ensemble-desktop/src-ui/src/components/ConfirmDialog.tsx`:
```tsx
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmClass?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmClass = "bg-red-600 hover:bg-red-500",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{message}</p>
        <div className="mt-4 flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-2 text-sm rounded-md text-white ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/Layout.tsx crates/ensemble-desktop/src-ui/src/components/StatusBadge.tsx crates/ensemble-desktop/src-ui/src/components/ConfirmDialog.tsx
git commit -m "feat: shared UI components — Layout, StatusBadge, ConfirmDialog with dark mode"
```

---

### Task 7: Dashboard Page with RunningTable, RetryQueue, AgentTotals

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/RunningTable.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/RetryQueue.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/AgentTotals.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/pages/Dashboard.tsx`

- [ ] **Step 1: Create RunningTable** — table with columns: Issue (link), Step, Turns, Last Event, Tokens, Runtime, Status badge. Props: `sessions: RunningSession[]`. Use `Link` from react-router-dom for issue identifiers. Include helper functions `formatDuration(startedAt)` and `formatTokens(n)`.

- [ ] **Step 2: Create RetryQueue** — table with columns: Issue (link), Attempt (X/max), Retry In (countdown), Error (truncated), Actions (Retry Now button). Props: `entries: RetryEntry[]`, `onRetry: (identifier: string) => void`.

- [ ] **Step 3: Create AgentTotals** — grid of stat cards: Input Tokens, Output Tokens, Total Tokens, Total Runtime. Plus optional rate limit display. Props: `totals: AgentTotals`, `rateLimits: RateLimitSnapshot | null`.

- [ ] **Step 4: Create Dashboard page** — uses `useStateQuery()`, `useRefreshMutation()`, `useRetryMutation()`. Renders header with Force Refresh button, 5 stat cards (running, retrying, + 3 from AgentTotals), RunningTable, RetryQueue. Handles loading/error states.

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds (or only missing page imports that haven't been created yet — stub them as empty components if needed).

- [ ] **Step 6: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/RunningTable.tsx crates/ensemble-desktop/src-ui/src/components/RetryQueue.tsx crates/ensemble-desktop/src-ui/src/components/AgentTotals.tsx crates/ensemble-desktop/src-ui/src/pages/Dashboard.tsx
git commit -m "feat: Dashboard page with running agents table, retry queue, and stats"
```

---

### Task 8: Issue Detail Page with EventTimeline and ConversationViewer

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/EventTimeline.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/components/ConversationViewer.tsx`
- Create: `crates/ensemble-desktop/src-ui/src/pages/IssueDetail.tsx`

- [ ] **Step 1: Create EventTimeline** — reverse-chronological event list. Props: `events: WsEventData[]`, `live: boolean`, `onViewConversation?: (index: number) => void`. Color-coded dots: green (turn_completed), purple (tool_call), blue (step_started/step_completed), gray (other). Each turn_completed shows "View in conversation" link.

- [ ] **Step 2: Create ConversationViewer** — paginated message list. Uses `useConversationQuery()`. Message type rendering: system (green bg), assistant (default), tool_call (purple bg with collapsible result via `<details>`). Pagination footer with Older/Newer buttons.

- [ ] **Step 3: Create IssueDetail page** — uses `useIssueDetailQuery()`, `useStopMutation()`, `useRetryMutation()`, and `connectWs()` from `../ws`. Two-column grid layout. Left: EventTimeline fed by WebSocket events. Right: ConversationViewer. Header with back link, identifier, badges, Stop/Retry button. 4 stat cards. Workspace info bar at bottom. ConfirmDialog for stop action.

WebSocket integration pattern:
```tsx
const [events, setEvents] = useState<WsEventData[]>([]);
const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");

useEffect(() => {
  return connectWs({
    identifier,
    enabled: isLiveRun,
    onMessage: (msg) => {
      if (msg.type === "snapshot") {
        setEvents(msg.events);
      } else if (msg.type === "event") {
        setEvents((prev) => [msg as unknown as WsEventData, ...prev]);
      }
    },
    onStatusChange: setWsStatus,
  });
}, [identifier, isLiveRun]);
```

- [ ] **Step 4: Verify build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/EventTimeline.tsx crates/ensemble-desktop/src-ui/src/components/ConversationViewer.tsx crates/ensemble-desktop/src-ui/src/pages/IssueDetail.tsx
git commit -m "feat: Issue Detail page with live event timeline and paginated conversation viewer"
```

---

### Task 9: History Page

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/pages/History.tsx`

- [ ] **Step 1: Create History page** — uses `useHistoryQuery()` with filter state. Filter bar: text input for issue search, select dropdowns for outcome/time range/step. Results table with clickable rows linking to `/issue/{identifier}`. Cursor-based pagination footer.

Filter state pattern:
```tsx
const [filters, setFilters] = useState({
  issue: "",
  outcome: "",
  since: "",
  step: "",
});
const [cursor, setCursor] = useState<string | undefined>();

const { data, isLoading, isError } = useHistoryQuery({
  ...filters,
  cursor,
  limit: 20,
});
```

- [ ] **Step 2: Verify build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/pages/History.tsx
git commit -m "feat: History page with filtering and pagination for completed runs"
```

---

### Task 10: Config Status Page

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/pages/ConfigStatus.tsx`

- [ ] **Step 1: Create ConfigStatus page** — uses `useConfigQuery()`. Renders validation banner (green/red), agents table, pipeline steps visual flow, runtime settings grid. All read-only.

- [ ] **Step 2: Verify build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/pages/ConfigStatus.tsx
git commit -m "feat: Config Status page showing effective configuration and validation"
```

---

### Task 11: Notification Panel

**Files:**
- Create: `crates/ensemble-desktop/src-ui/src/components/NotificationPanel.tsx`

- [ ] **Step 1: Create NotificationPanel** — dropdown panel rendering notifications from the notification store. Props: `open: boolean`, `onClose: () => void`. Renders notification list with severity dots, title, detail, timestamp. "Mark all read" button. Clicking a notification navigates to the issue detail page.

Also add notification generation logic to the Dashboard page: compare previous and current state responses to detect new failures, retries, and completions. Call `addNotification()` and `requestPermissionIfNeeded()` from `../notifications`.

- [ ] **Step 2: Update Layout to import NotificationPanel** (if stubbed in Task 14, replace the stub with the real import).

- [ ] **Step 3: Verify full build**

Run: `npm --prefix crates/ensemble-desktop/src-ui run build`
Expected: Build succeeds with zero errors.

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-desktop/src-ui/src/components/NotificationPanel.tsx crates/ensemble-desktop/src-ui/src/components/Layout.tsx crates/ensemble-desktop/src-ui/src/pages/Dashboard.tsx
git commit -m "feat: notification panel with browser Notification API and state-diff detection"
```

---

**Next:** Plan 6 adds the Tauri desktop wrapper and full build verification.
