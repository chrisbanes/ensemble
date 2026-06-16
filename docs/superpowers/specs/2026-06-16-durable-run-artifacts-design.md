# Durable Run Artifacts and Step Logs

Date: 2026-06-16
Status: Draft for review

## Goal

Make every Ensemble run leave durable, dashboard-visible artifacts regardless of
finalize mode, and make every workflow step on the issue detail page a stable
link to its logs/transcript view.

## Why

The current runtime already has a finalize phase with per-repo modes
(`none`, `push`, `push_and_pr`) and persisted per-step transcripts. The gaps are
mostly in durability and dashboard visibility:

- `finalize.mode` should continue to default to `none`.
- A task can produce useful work even when nothing is pushed.
- Completed issue details should still show workspaces, repo state, transcripts,
  and PR links when present.
- Workflow step rows should not become disabled just because a transcript is
  missing, pending, or only available through history.

## Scope

In scope:

- A durable run artifact bundle stored with completed history.
- Artifact capture for `none`, `push`, and `push_and_pr` finalize modes.
- Dashboard issue detail artifact panel.
- Always-clickable workflow step navigation.
- Step detail pages that show metadata, events, and transcript/log state.
- Structured finalize outputs for pushed refs and PR URLs.

Out of scope:

- Changing finalize defaults.
- Rich PR title/body templating.
- Storing full transcript contents in history records.
- New tracker-specific artifact integrations.
- Workspace cleanup redesign.

## Artifact Model

Add a durable artifact bundle to each run/history record:

```rust
pub struct RunArtifacts {
    pub run_id: String,
    pub workspace_path: String,
    pub repos: Vec<RepoArtifact>,
    pub transcripts: Vec<StepTranscriptArtifact>,
}

pub struct RepoArtifact {
    pub repo: String,
    pub worktree_path: String,
    pub base_branch: String,
    pub branch: String,
    pub head_sha: Option<String>,
    pub changed_files: Vec<String>,
    pub finalize_mode: String,
    pub finalize_status: String,
    pub pushed_ref: Option<String>,
    pub pr_url: Option<String>,
    pub last_error: Option<String>,
}

pub struct StepTranscriptArtifact {
    pub step_name: String,
    pub run_id: String,
    pub record_count: usize,
}
```

Semantics:

- `finalize.mode: none` still records workspace, worktree, branch, head SHA,
  changed files, finalize mode/status, and transcript pointers.
- `finalize.mode: push` adds pushed-ref status when the push succeeds.
- `finalize.mode: push_and_pr` adds the PR URL when a PR is created or an
  existing PR is found.
- Transcript artifacts are pointers and summaries. Transcript record files stay
  in the existing per-run/per-step transcript store.
- Keep the existing `HistoryRecord.workspace_path` field for compatibility.
  `HistoryRecord.artifacts.workspace_path` becomes the richer source when
  present.

## Lifecycle

Artifact collection happens in two passes.

### Pipeline Terminal Pass

When the pipeline reaches a terminal outcome, collect baseline artifacts:

- run id
- workspace path
- configured repo names
- per-repo worktree paths
- current branch
- head SHA
- changed files
- configured finalize mode
- baseline finalize status
- transcript summary for each workflow step

This pass runs for successful, failed, and stopped runs because transcripts and
workspace state are useful even when the run did not succeed.

### Finalize Update Pass

When finalize executes, update the same artifact bundle:

- pushed ref
- repo finalize status
- PR URL
- last error

Finalize retry updates the same artifact bundle rather than creating a second
artifact set.

Completion behavior stays aligned with current finalize semantics:

- `finalize.mode: none`: issue may complete after pipeline success, with
  artifacts.
- `finalize.mode: push` or `push_and_pr`: issue completes only after required
  finalize actions succeed.
- finalize failure keeps the issue visible in a non-complete finalize state and
  keeps the current artifact bundle available for inspection.

## API Contract

Extend API snapshots with artifacts:

- `HistoryRecord.artifacts: Option<RunArtifacts>`
- `IssueDetailSnapshot.artifacts: Option<RunArtifacts>`
- `StepDetailSnapshot.run_id: Option<String>`
- `StepDetailSnapshot.transcript: Option<StepTranscriptArtifact>`

The existing transcript endpoints stay unchanged:

```text
GET /api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation
GET /api/v1/{identifier}/runs/{run_id}/steps/{step_name}/conversation/{sequence}
```

Step detail should include enough data for the UI to decide whether to render a
transcript viewer, an empty transcript state, or an error state. It should not
require the issue to be currently running.

Finalize execution should return structured output instead of only
`Result<(), String>`:

```rust
pub struct FinalizeActionOutput {
    pub pushed_ref: Option<String>,
    pub pr_url: Option<String>,
}
```

For `push_and_pr`, an existing PR is a successful finalize result and should
store the discovered PR URL.

## Dashboard Design

Issue detail gets a first-class Artifacts panel.

The panel shows:

- workspace path
- repo rows with repo, branch, head SHA, changed file count/list, finalize mode,
  and finalize status
- pushed ref when available
- PR link when available
- finalize error when failed
- transcript links for every workflow step

Home/dashboard cards stay compact:

- no change to finalize defaults
- show status normally
- optionally show a small external PR action when artifacts include a PR URL
- finalize failures remain inspectable from issue detail

## Workflow Step Navigation

Workflow steps on issue detail are always clickable.

Rules:

- Every workflow step row links to step detail regardless of state.
- Pending, running, passed, failed, waiting, finalize-adjacent, and
  completed/history-backed steps all have a detail route.
- Missing logs are represented by an empty state, not a disabled link.
- The UI should stop using `can_navigate` to disable step links. The field may
  remain in API responses for compatibility or diagnostics, but it should not
  control dashboard navigation.

Step detail combines:

- step metadata and status
- filtered event timeline
- transcript/log viewer when records exist
- empty state when no transcript has been recorded yet
- artifact pointers for that step/run when available

For completed/history-backed issues, `workflow_steps` should remain navigable
whenever the step exists in history. A transcript pointer enriches the page, but
it is not required to open the step detail route.

## Persistence Strategy

Use `HistoryRecord` as the durable source for completed issue artifacts.

Active issue detail should expose artifacts from orchestrator state when
available. Completed issue detail should rebuild artifacts from history. This
keeps the dashboard useful after the in-memory completed-entry retention window
expires.

Transcript files are not embedded in history. History stores `run_id`,
`step_name`, and summary metadata so the existing transcript reader can load the
records from the run transcript store.

## Testing Strategy

Core tests:

- history records round-trip optional artifacts
- artifact collection for `finalize.mode: none`
- artifact collection for failed/stopped runs
- `push` finalize stores pushed ref/status
- `push_and_pr` stores PR URL for both created and already-existing PRs
- finalize retry updates the existing artifact bundle
- issue detail includes artifacts for active, finalize, and history-backed
  completed issues
- step detail includes run/transcript metadata after completion

UI tests:

- issue detail renders artifact panel with repo rows
- issue detail renders PR links when present
- workflow steps are clickable regardless of state
- step detail renders transcript viewer when records exist
- step detail renders an empty state when no transcript exists

Docs tests/checks:

- configuration docs state that finalize defaults remain `none`
- API/spec docs describe durable artifacts and always-clickable step logs

## Documentation Updates

Update:

- `docs/SPEC.md` for durable run artifacts and step log navigation.
- `docs/configuration.md` to clarify that `repos[].finalize.mode` defaults to
  `none`.
- Any dashboard/API reference docs that describe issue detail, step detail, or
  finalize state.

## Risks

- **History records grow too large.** Store summaries and pointers, not full
  transcripts. Changed files should be bounded or paginated if needed.
- **Workspace cleanup breaks artifact links.** The artifact still records what
  existed. Future cleanup work should distinguish durable metadata from live
  workspace availability.
- **PR URL discovery is incomplete.** Treat created PR and already-existing PR
  lookup as first-class success paths and persist the URL from either path.
- **Step pages with no logs feel broken.** Use explicit empty states so stable
  navigation does not imply data must already exist.
