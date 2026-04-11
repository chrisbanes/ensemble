# Web App Improvements Design

**Date:** 2026-04-11  
**Status:** Approved  
**Scope:** Dashboard Kanban, Step Detail Page, Agent Log Fix, Issue Detail Enhancement, Completed State

## 1. Overview

This design addresses five UI/UX improvements to the Ensemble web application:

1. **Home Page Kanban Board** - Replace the current dashboard list with a Kanban board showing all tasks organized by state
2. **Step Detail Page** - Create a dedicated page for viewing step-specific agent logs and configuration
3. **Agent Log Fix** - Fix the issue where each output word appears as a separate list item
4. **Issue Detail Enhancement** - Add workflow steps sidebar and full issue information
5. **Completed State with Expiry** - Allow viewing recently completed issues without 404 errors

## 2. Dashboard Kanban Board

### 2.1 Route
- **Path:** `/` (replaces current Dashboard)

### 2.2 Layout
Horizontal scrollable Kanban board with 5 columns:

| Column | Status Values | Color |
|--------|---------------|-------|
| Running | `running` | Green |
| Retrying | `retrying` | Yellow |
| Waiting on Human | `waiting_on_human` | Blue |
| Finalizing | `finalize_*` (pending_approval, in_progress, succeeded, failed) | Purple |
| Completed | `completed_*` (succeeded, failed, stopped) | Gray |

### 2.3 Issue Card Design
Each card displays:
- **Identifier** (clickable link to `/issue/:identifier`)
- **Title** (truncated to 1 line, full text on hover)
- **Current Step** badge (if running)
- **Age** (e.g., "2m ago", "1h ago")
- **Token count** (if available, formatted as "1.2k" or "1.5M")

Card styling:
- Compact card with 1px border
- Status color indicator on left edge (4px wide)
- Subtle hover shadow effect

### 2.4 Responsive Behavior
- **Desktop (>1024px):** All 5 columns visible, horizontal scroll if content overflows
- **Tablet (768-1024px):** 3 columns visible, swipe or horizontal scroll for others
- **Mobile (<768px):** Single column view with tabs or swipe between states

### 2.5 Data Flow
- Reuse existing `useStateQuery()` hook
- Group issues by `status` field client-side using `Array.prototype.reduce()`
- No backend changes required

### 2.6 Components
- `KanbanBoard.tsx` - Main container with drag-scroll
- `KanbanColumn.tsx` - Individual column with header and count
- `IssueCard.tsx` - Individual issue card

## 3. Step Detail Page

### 3.1 Route
- **Path:** `/issue/:identifier/step/:stepName`
- **Example:** `/issue/repo-42/step/build`

### 3.2 Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  Breadcrumb: Issue > repo-42 > Step > build             │
│  [Status Badge]                    [Back to Issue]      │
├─────────────────────────────────────────────────────────┤
│  STEP CONFIGURATION                                     │
│  ├─ Agent: builder                                      │
│  ├─ Dependencies: setup                                 │
│  ├─ Approval: WhenRequestedByAgent                      │
│  └─ Tracker State: in_progress                          │
├─────────────────────────────────────────────────────────┤
│  STEP STATUS                                            │
│  ├─ State: Running [spinner]                            │
│  ├─ Started: 2m ago                                     │
│  ├─ Duration: 1m 30s                                    │
│  └─ Attempt: 1                                          │
├─────────────────────────────────────────────────────────┤
│  AGENT LOG                                              │
│  ├─ [aggregated conversation messages]                  │
│  └─ Tool calls [expandable]                             │
├─────────────────────────────────────────────────────────┤
│  TIMELINE EVENTS (filtered to this step)                │
│  └─ [event list with links to full timeline]            │
└─────────────────────────────────────────────────────────┘
```

### 3.3 Backend Changes

**New API Endpoint:**
```
GET /api/v1/{identifier}/step/{step_name}
```

**Response Type:**
```rust
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StepDetailSnapshot {
    pub issue_identifier: String,
    pub step_name: String,
    pub config: StepConfigInfo,
    pub status: StepStatusInfo,
    pub events: Vec<StepEventSummary>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StepConfigInfo {
    pub agent: String,
    pub dependencies: Vec<String>,
    pub approval_mode: Option<String>,
    pub tracker_state: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StepStatusInfo {
    pub state: String,  // "pending", "running", "passed", "failed"
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub attempt: u32,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct StepEventSummary {
    pub timestamp: DateTime<Utc>,
    pub event_type: String,
    pub detail: String,
}
```

### 3.4 Frontend Components
- `StepDetail.tsx` - Main page component
- `StepConfigCard.tsx` - Configuration display
- `StepStatusCard.tsx` - Status metrics
- `StepConversationViewer.tsx` - Filtered conversation (aggregated output)
- `StepEventList.tsx` - Filtered timeline events

## 4. Agent Log Fix

### 4.1 Problem
`OutputChunk` events emit individual tokens/words to the timeline, creating one list item per word and making the log unreadable.

### 4.2 Solution
Frontend aggregation in `EventTimeline` component that groups consecutive `output` events.

### 4.3 Implementation

**Aggregation Logic:**
```typescript
interface AggregatedEvent extends WsEventData {
  aggregatedCount?: number;
}

function aggregateOutputEvents(events: WsEventData[]): AggregatedEvent[] {
  const result: AggregatedEvent[] = [];
  let outputBuffer: WsEventData[] = [];
  
  for (const event of events) {
    if (event.type === 'output') {
      outputBuffer.push(event);
    } else {
      if (outputBuffer.length > 0) {
        result.push(flushOutputBuffer(outputBuffer));
        outputBuffer = [];
      }
      result.push(event);
    }
  }
  
  if (outputBuffer.length > 0) {
    result.push(flushOutputBuffer(outputBuffer));
  }
  
  return result;
}

function flushOutputBuffer(buffer: WsEventData[]): AggregatedEvent {
  const first = buffer[0];
  const content = buffer.map(e => e.detail).join('');
  return {
    ...first,
    detail: content,
    aggregatedCount: buffer.length > 1 ? buffer.length : undefined
  };
}
```

**Display:**
- Single "Output" event with full concatenated content
- Badge showing "(12 chunks)" if aggregated from multiple events
- Content rendered with `whitespace-pre-wrap` for formatting

### 4.4 No Backend Changes
The timeline events remain granular for debugging purposes. Aggregation happens at display time only.

## 5. Issue Detail Enhancement

### 5.1 New Layout

```
┌─────────────────────────────────────────────────────────┐
│  ← repo-42                          [Stop] [Retry]      │
│  [Running Badge] [WS: connected]                        │
├─────────────────────────────────────────────────────────┤
│  Turns: 7  │  Step: build  │  Tokens: 1.2k  │  Attempt: 1│
├──────────────┬──────────────────────────────────────────┤
│              │                                          │
│  WORKFLOW    │     EVENT TIMELINE    CONVERSATION       │
│  ──────────  │     ──────────────    ───────────        │
│              │                                          │
│  ○ setup     │     [aggregated events]  [messages]      │
│  ● build     │                                          │
│  ○ test      │                                          │
│  ○ review    │                                          │
│              │                                          │
│  ISSUE INFO  │                                          │
│  ──────────  │                                          │
│  Title:      │                                          │
│  Fix auth bug│                                          │
│              │                                          │
│  Labels:     │                                          │
│  [bug][p1]   │                                          │
│              │                                          │
│  [View on    │                                          │
│   GitHub]    │                                          │
│              │                                          │
└──────────────┴──────────────────────────────────────────┘
```

### 5.2 Workflow Steps Sidebar

**Display:**
- Shows all steps from `config.pipeline.steps` in DAG order
- Each step shows: status icon, name, agent
- Status icons: ○ Pending, ● Running (spinner), ✓ Passed, ✗ Failed, ⊘ Blocked
- Dependency arrows between steps
- Click navigates to `/issue/:identifier/step/:stepName`

**Backend Changes:**
Add to `IssueDetailSnapshot`:
```rust
pub struct WorkflowStepInfo {
    pub name: String,
    pub agent: String,
    pub dependencies: Vec<String>,
    pub state: String,  // "pending", "running", "passed", "failed"
    pub can_navigate: bool,  // true if step has any activity
}

// Add to IssueDetailSnapshot:
pub workflow_steps: Vec<WorkflowStepInfo>,
```

### 5.3 Issue Info Section

**Display:**
- **Title** - Full issue title from tracker
- **Description** - Collapsible if >3 lines
- **Labels** - Badge chips
- **Priority** - Indicator if available
- **External URL** - "View on GitHub" link

**Backend Changes:**
Add to `IssueDetailSnapshot`:
```rust
pub issue: IssueSummary,

pub struct IssueSummary {
    pub title: String,
    pub description: Option<String>,
    pub labels: Vec<String>,
    pub priority: Option<i32>,
    pub url: Option<String>,
}
```

## 6. Completed State with Expiry

### 6.1 Problem
When an issue finishes, it's removed from `running`. The issue detail endpoint returns 404: "no running, waiting, or retrying issue with identifier 'xxx'".

### 6.2 Solution
Add a `completed` cache to `OrchestratorState` with automatic expiry.

### 6.3 Backend Changes

**New Data Structures:**
```rust
// In orchestrator/state.rs
pub struct CompletedEntry {
    pub issue_id: String,
    pub identifier: String,
    pub status: String,  // "completed_succeeded", "completed_failed", "completed_stopped"
    pub completed_at: DateTime<Utc>,
    pub outcome_summary: Option<String>,
}

pub struct OrchestratorState {
    // ... existing fields ...
    pub completed: HashMap<String, CompletedEntry>,  // key: issue_id
    pub completed_expiry_secs: u64,  // default: 259200 (3 days)
}
```

**Add Method:**
```rust
impl OrchestratorState {
    pub fn add_completed(&mut self, issue_id: String, identifier: String, status: String) {
        self.completed.insert(
            issue_id.clone(),
            CompletedEntry {
                issue_id,
                identifier,
                status,
                completed_at: Utc::now(),
                outcome_summary: None,
            }
        );
    }
    
    pub fn cleanup_expired_completed(&mut self) {
        let now = Utc::now();
        let expiry = Duration::seconds(self.completed_expiry_secs as i64);
        self.completed.retain(|_, entry| {
            now.signed_duration_since(entry.completed_at) < expiry
        });
    }
}
```

**Orchestrator Integration:**
- Call `cleanup_expired_completed()` in the main tick loop
- Call `add_completed()` when a run succeeds/fails/stops

**API Changes:**
Update `build_issue_snapshot()` to check the `completed` map:
```rust
// Check completed entries
let completed_entry = state.completed.values().find(|e| e.identifier == identifier);

// In status resolution:
if let Some(entry) = completed_entry {
    status = entry.status.clone();
}
```

**Configuration:**
Add to `EnsembleConfig`:
```yaml
orchestrator:
  completed_expiry_secs: 259200  # 3 days default
```

### 6.4 Frontend Changes

**StatusBadge Component:**
Add support for new statuses:
- `completed_succeeded` - Green check badge
- `completed_failed` - Red X badge  
- `completed_stopped` - Gray stopped badge

**IssueDetail Page:**
- Show completed issues as read-only
- Hide Stop/Retry buttons for completed issues
- Show "Completed X time ago" indicator

## 7. Data Flow Summary

```
┌─────────────────────────────────────────────────────────────┐
│                     Backend (Rust)                          │
├─────────────────────────────────────────────────────────────┤
│  OrchestratorState                                          │
│  ├── running: HashMap<...>                                  │
│  ├── waiting_on_human: HashMap<...>                         │
│  ├── retry_attempts: HashMap<...>                           │
│  ├── finalize: HashMap<...>                                 │
│  └── completed: HashMap<...>  [NEW]                         │
│                                                             │
│  IssueDetailSnapshot                                        │
│  ├── issue: IssueSummary  [NEW]                             │
│  ├── workflow_steps: Vec<WorkflowStepInfo>  [NEW]          │
│  └── ...existing fields...                                  │
│                                                             │
│  StepDetailSnapshot  [NEW ENDPOINT]                         │
│  ├── config: StepConfigInfo                                 │
│  ├── status: StepStatusInfo                                 │
│  └── events: Vec<StepEventSummary>                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP / WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Frontend (React)                          │
├─────────────────────────────────────────────────────────────┤
│  Dashboard (/)                                              │
│  └── KanbanBoard                                            │
│      └── KanbanColumn (×5)                                  │
│          └── IssueCard                                      │
│                                                             │
│  IssueDetail (/issue/:id)                                   │
│  ├── StatsCards                                             │
│  ├── WorkflowStepsSidebar  [NEW]                            │
│  │   └── StepList with links                                │
│  ├── IssueInfoSection  [NEW]                                │
│  └── EventTimeline (with aggregation)  [MODIFIED]           │
│                                                             │
│  StepDetail (/issue/:id/step/:name)  [NEW ROUTE]           │
│  ├── StepConfigCard                                         │
│  ├── StepStatusCard                                         │
│  ├── StepConversationViewer                                 │
│  └── StepEventList                                          │
└─────────────────────────────────────────────────────────────┘
```

## 8. Error Handling

### 8.1 Issue Not Found
If an issue is not in running, waiting, retrying, finalize, or completed:
- Return 404 with message: "Issue not found or has expired from completed cache"
- Frontend shows error page with link to History

### 8.2 Step Not Found
If step name doesn't exist in workflow:
- Return 404 with message: "Step '{name}' not found in workflow"
- Frontend redirects back to issue detail

### 8.3 Expired Completed Issue
If issue was completed but has expired from cache:
- Return 404 with message: "Issue completed. View in History for details."
- Show link to `/history` with identifier filter

## 9. Testing Strategy

### 9.1 Backend Tests
- Test `add_completed()` adds entry correctly
- Test `cleanup_expired_completed()` removes old entries
- Test `build_issue_snapshot()` finds completed entries
- Test step detail endpoint returns correct data

### 9.2 Frontend Tests
- Test Kanban board groups issues by status correctly
- Test output event aggregation logic
- Test step detail page navigation
- Test completed status badge rendering

## 10. Component Reuse Strategy

### 10.1 UI Primitive Components (Reuse As-Is)

| Component | Location | Usage |
|-----------|----------|-------|
| `Card`, `CardHeader`, `CardContent`, `CardTitle` | `components/ui/card.tsx` | Kanban cards, step config/status cards, sidebar sections |
| `Badge` | `components/ui/badge.tsx` | Status badges, step indicators, labels |
| `Button` | `components/ui/button.tsx` | All action buttons |
| `Table`, `TableRow`, `TableCell` | `components/ui/table.tsx` | Step events list (optional) |
| `Textarea` | `components/ui/textarea.tsx` | Already used in InteractionPanel |

### 10.2 Existing Components to Extend

| Component | Change | Details |
|-----------|--------|---------|
| `StatusBadge.tsx` | **Extend** | Add variants: `completed_succeeded`, `completed_failed`, `completed_stopped` |
| `EventTimeline.tsx` | **Modify** | Add `aggregateOutputEvents()` function to group consecutive output chunks |
| `ConversationViewer.tsx` | **Extend** | Create wrapper component `StepConversationViewer.tsx` that filters by step |
| `ConfirmDialog.tsx` | **Reuse** | Already generic, no changes needed |

### 10.3 Utility Functions to Extract

From `RunningTable.tsx`:
```typescript
// Extract to src/lib/utils.ts or src/lib/formatters.ts
export function formatDuration(startedAt: string): string
export function formatTokens(n: number): string
```

From `EventTimeline.tsx`:
```typescript
// Reuse existing
const dotColors: Record<string, string>
function formatTime(timestamp: string): string
```

### 10.4 New Components to Create

| Component | Purpose | Composed From |
|-----------|---------|---------------|
| `KanbanBoard.tsx` | Main Kanban container | Card, custom drag-scroll logic |
| `KanbanColumn.tsx` | Individual column | Card, CardHeader, Badge |
| `IssueCard.tsx` | Kanban issue card | Card, Badge, Link |
| `WorkflowStepsSidebar.tsx` | Left sidebar | Card, CardHeader, Badge, custom step list |
| `IssueInfoSection.tsx` | Issue metadata display | Card, CardHeader, Badge |
| `StepDetail.tsx` | Main step page | Page layout, existing cards |
| `StepConfigCard.tsx` | Step configuration | Card, CardHeader, CardContent |
| `StepStatusCard.tsx` | Step status metrics | Card, CardHeader, Badge |
| `StepEventList.tsx` | Filtered events | EventTimeline pattern |
| `StepConversationViewer.tsx` | Step-filtered conversation | ConversationViewer wrapper |

### 10.5 Component Composition Pattern

Example: IssueCard composition
```tsx
// IssueCard.tsx
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import StatusBadge from "./StatusBadge";

export function IssueCard({ issue }) {
  return (
    <Card className="border-l-4 border-l-green-500">
      <CardContent className="p-3">
        <Link to={`/issue/${issue.identifier}`}>
          {issue.identifier}
        </Link>
        <Badge variant="outline">{issue.step_name}</Badge>
        <StatusBadge status={issue.status} />
      </CardContent>
    </Card>
  );
}
```

## 12. Implementation Order

1. **Backend foundation:**
   - Add `CompletedEntry` and `completed` map to `OrchestratorState`
   - Add expiry configuration (3 days default)
   - Update `build_issue_snapshot()` to check completed

2. **Agent log fix:**
   - Add `aggregateOutputEvents()` to `EventTimeline.tsx`
   - Test with live streaming output

3. **Dashboard Kanban:**
   - Extract `formatDuration()` and `formatTokens()` to utils
   - Create Kanban components (compose from existing Card, Badge)
   - Replace Dashboard page

4. **Issue detail enhancement:**
   - Extend `StatusBadge.tsx` with completed variants
   - Add workflow steps to API response
   - Add issue info to API response
   - Create sidebar components (compose from Card, Badge)
   - Update IssueDetail layout with sidebar

5. **Step detail page:**
   - Create step detail API endpoint
   - Create StepDetail page and components
   - Create `StepConversationViewer` wrapper
   - Add route to App.tsx

## 13. Open Questions

None - all sections approved.

## 14. Appendix: File Changes

### 14.1 New Utility Functions
- `src/lib/formatters.ts` - **NEW**: Extract `formatDuration()`, `formatTokens()` from RunningTable.tsx

### 14.2 Backend (ensemble-core)
- `src/orchestrator/state.rs` - Add CompletedEntry, completed map, expiry
- `src/orchestrator/mod.rs` - Add to completed on finish, cleanup in tick
- `src/observability/snapshot.rs` - Add workflow_steps, issue fields
- `src/api/handlers.rs` - Check completed in build_issue_snapshot
- `src/api/router.rs` - Add step detail route
- `src/api/step_handler.rs` - NEW: Step detail endpoint
- `src/config/ensemble.rs` - Add completed_expiry_secs config

### 14.3 Frontend (ensemble-ui) - Modified/Extended
- `src/pages/Dashboard.tsx` - Replace table with KanbanBoard
- `src/components/EventTimeline.tsx` - Add `aggregateOutputEvents()` function
- `src/pages/IssueDetail.tsx` - Add sidebar layout with WorkflowStepsSidebar
- `src/components/StatusBadge.tsx` - Add completed_succeeded, completed_failed, completed_stopped variants
- `src/App.tsx` - Add step detail route
- `src/hooks.ts` - Add `useStepDetailQuery()` hook
- `src/components/RunningTable.tsx` - Extract formatters to utils (cleanup)

### 14.4 Frontend (ensemble-ui) - New Components
- `src/lib/formatters.ts` - NEW: Shared formatting utilities
- `src/components/KanbanBoard.tsx` - NEW: Composed from Card, CardHeader, Badge
- `src/components/KanbanColumn.tsx` - NEW: Composed from Card, CardHeader, Badge
- `src/components/IssueCard.tsx` - NEW: Composed from Card, Badge, StatusBadge
- `src/components/WorkflowStepsSidebar.tsx` - NEW: Composed from Card, CardHeader, Badge
- `src/components/IssueInfoSection.tsx` - NEW: Composed from Card, CardHeader, Badge
- `src/pages/StepDetail.tsx` - NEW: Page layout
- `src/components/StepConfigCard.tsx` - NEW: Composed from Card, CardHeader, CardContent
- `src/components/StepStatusCard.tsx` - NEW: Composed from Card, CardHeader, Badge
- `src/components/StepEventList.tsx` - NEW: Uses EventTimeline pattern
- `src/components/StepConversationViewer.tsx` - NEW: Wraps ConversationViewer with filtering

## Key Learnings

- The conversation viewer (`ConversationViewer.tsx`) and timeline events are separate systems
- `OutputChunk` events in the agent runtime create individual timeline entries
- Issue data from the tracker (title, description, labels) isn't currently exposed in the API
- Step state is stored in `PipelineRun.step_states` but not exposed in the detail API
- The orchestrator removes entries from `running` immediately on completion, causing 404s
