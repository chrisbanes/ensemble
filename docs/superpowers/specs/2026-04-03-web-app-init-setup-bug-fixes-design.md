# Web App Init/Setup Bug Fixes Design

## Summary

Fix 7 bugs in the Ensemble web app's configuration setup flow: dashboard redirect, tracker type display, file browsers for paths, agent discovery timeout, custom agent option, and agent prompt configuration.

## Bug Fixes

### 1. Dashboard redirect when no config

**Problem**: Opening the app shows an empty dashboard when config is missing instead of guiding the user to setup.

**Fix**: In `Dashboard.tsx`, add `useConfigStateQuery()` (already used by `Layout.tsx` and `ConfigPage.tsx`) and render `<Navigate to="/config" replace />` when `state === "missing"`. The config query is already polled every 3 seconds, so no new API calls needed.

**Files**: `crates/ensemble-ui/src-ui/src/pages/Dashboard.tsx`

### 2. Tracker type shows raw key instead of label

**Problem**: In `GuidedEditor.tsx`, the tracker `kind` field is a plain text input showing `"todo_file"` instead of a human-readable label.

**Fix**: Replace the `<Input>` with a `<Select>` component that maps:
- `todo_file` → "Todo File"
- `github` → "GitHub Project"

**Files**: `crates/ensemble-ui/src-ui/src/components/config/GuidedEditor.tsx`

### 3-4. File browsers for Tracker path and Repository path

**Problem**: Path fields in both `SetupWizard.tsx` and `GuidedEditor.tsx` are plain text inputs with no way to browse the filesystem.

**Backend**: Add `GET /api/v1/fs/list?path=/some/path` endpoint.
- Lists directory contents (directories and files), sorted: directories first, then files, alphabetically within each group
- Restricted to home directory and below for safety. Home directory = `dirs::home_dir()` (the user running the server). Symlinks are resolved via `std::fs::canonicalize()` before checking the home boundary. Symlinks that resolve outside home are excluded from results.
- Returns `{ entries: [{ name, is_dir, path }] }` limited to 500 entries (truncated with `truncated: true` flag if exceeded)
- If path is outside home dir, returns 403
- Error responses follow the existing `ApiError` format: `{ code: string, message: string }`

**Frontend**: Create a reusable `FileBrowser` component.
- Modal dialog (`Dialog` from Radix UI) with directory listing, breadcrumb navigation, and select button
- Accepts a `mode` prop: `"file"` (select files only) or `"directory"` (select directories only)
- Double-click directories to navigate, single-click items to select (filtered by mode)
- "Browse" button next to path inputs in SetupWizard (tracker step uses `"file"` mode, repos step uses `"directory"` mode) and GuidedEditor (tracker section uses `"file"` mode)

**Files**:
- Backend: `crates/ensemble-core/src/api/fs_handler.rs` (new), `crates/ensemble-core/src/api/mod.rs` (add `pub mod fs_handler`), `crates/ensemble-core/src/api/router.rs`
- Frontend: `crates/ensemble-ui/src-ui/src/components/config/FileBrowser.tsx` (new)
- Updated: `SetupWizard.tsx`, `GuidedEditor.tsx`

### 5. Agent discovery timeout

**Problem**: `probe_agent()` in `setup.rs` uses `std::process::Command` with no timeout. If `acpx` hangs for any agent, the entire discovery blocks indefinitely. The same issue affects `get_agent_version()` and the health checks in `run_setup_checks()`.

**Fix**: Convert `probe_agent()` and `get_agent_version()` to use `tokio::process::Command` with `tokio::time::timeout` at 8 seconds per agent. The `run_setup_checks()` health checks also use blocking commands and should be converted similarly.

**Files**: `crates/ensemble-core/src/config/setup.rs`

### 6. Custom agent option

**Problem**: The agent dropdown only shows discovered agents. Users cannot specify a custom agent not in the known list.

**Fix**: Add "Custom" option at the bottom of the agent select dropdown. When selected, show a text input for the custom agent name. The `acpx_agent` field stores the custom name. The existing setup validation already runs an agent health check that will catch invalid custom names, so no additional backend changes needed. The UI should show a subtle warning when a custom name is entered: "Custom agents are not validated — ensure this agent is installed and accessible via acpx."

**Files**: `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx`

### 7. Agent prompt configuration

**Problem**: No way to set a prompt or prompt file for agents in the setup wizard.

**Fix**: Add a prompt section to each agent card with:
- Toggle between "Inline text" and "File path"
- Inline: textarea for prompt content
- File: text input with browse button (reuses FileBrowser component in `"file"` mode)
- Store as `prompt` (string) or `prompt_file` (string path) in `SetupAgent`. When saving to YAML, `prompt_file` maps to the existing `prompt_template` field in the config schema.

**Files**: `crates/ensemble-ui/src-ui/src/components/config/SetupWizard.tsx`

## API Changes

### New endpoint: `GET /api/v1/fs/list`

**Query parameters**:
- `path` (required): Directory path to list

**Response** (200):
```json
{
  "entries": [
    { "name": "src", "is_dir": true, "path": "/home/user/project/src" },
    { "name": "Cargo.toml", "is_dir": false, "path": "/home/user/project/Cargo.toml" }
  ]
}
```

**Errors**:
- 400: Missing path parameter
- 403: Path outside home directory
- 404: Path does not exist
- 500: I/O error

## Model Changes

### `SetupAgent` (frontend type)
Add optional fields:
- `prompt?: string` — inline prompt text
- `prompt_file?: string` — path to prompt template file

## Implementation Order

1. Backend: File browser API endpoint + tests
2. Backend: Agent discovery timeout + tests
3. Frontend: Dashboard redirect
4. Frontend: Tracker type label in GuidedEditor
5. Frontend: FileBrowser component + tests
6. Frontend: File browser integration in SetupWizard
7. Frontend: File browser integration in GuidedEditor
8. Frontend: Custom agent option in SetupWizard
9. Frontend: Agent prompt configuration in SetupWizard

## Test Strategy

- **Backend**: Unit tests for `fs/list` endpoint (valid path, path outside home, nonexistent path, symlink escape)
- **Backend**: Unit tests for `probe_agent()` timeout behavior
- **Frontend**: Component tests for `FileBrowser` navigation, mode filtering, and selection
