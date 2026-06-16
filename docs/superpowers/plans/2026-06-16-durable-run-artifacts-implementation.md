# Durable Run Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist durable run artifacts for every task, surface them on issue/step detail pages, and make workflow step log navigation always available.

**Architecture:** Add a small artifact domain model to `ensemble-core`, store it on history records and in SQLite as JSON, collect baseline artifacts at pipeline terminal time, then enrich the same artifacts during finalize. API snapshots expose artifacts and step transcript summaries; the React dashboard renders an artifacts panel and always links workflow steps to step detail routes.

**Tech Stack:** Rust 2021, serde, rusqlite, tokio process commands, utoipa schemas, Axum API handlers, React 19, TanStack Query, Vitest, existing Orval codegen.

---

## File Structure

- Create `crates/ensemble-core/src/history/artifacts.rs`
  - Owns `RunArtifacts`, `RepoArtifact`, `StepTranscriptArtifact`, `FinalizeActionOutput`, and artifact collection helpers.
- Modify `crates/ensemble-core/src/history/mod.rs`
  - Re-export the new artifacts module.
- Modify `crates/ensemble-core/src/history/model.rs`
  - Add `artifacts: Option<RunArtifacts>` to `HistoryRecord`.
- Modify `crates/ensemble-core/src/history/writer.rs`
  - Update tests/sample records for optional artifacts.
- Modify `crates/ensemble-core/src/history/reader.rs`
  - Update tests/sample records.
- Modify `crates/ensemble-core/src/history_store/schema.rs`
  - Add an `artifacts` JSON text column to `runs` and migrate existing DBs.
- Modify `crates/ensemble-core/src/history_store/model.rs`
  - Decode artifacts JSON into `HistoryRecord`.
- Modify `crates/ensemble-core/src/history_store/store.rs`
  - Insert/update/select artifacts.
- Modify `crates/ensemble-core/src/orchestrator/state.rs`
  - Store in-memory artifacts keyed by issue id while finalize may still be pending.
- Modify `crates/ensemble-core/src/orchestrator/mod.rs`
  - Build baseline artifacts, update them from finalize output, write artifacts to history, and preserve artifact state during finalize retry.
- Modify `crates/ensemble-core/src/observability/snapshot.rs`
  - Add artifacts to `IssueDetailSnapshot`, transcript metadata to `StepDetailSnapshot`, and make history/completed steps navigable.
- Modify `crates/ensemble-core/src/api/handlers.rs`
  - Return artifacts from history-backed issue detail and transcript summaries from step detail.
- Modify `crates/ensemble-core/src/api/openapi.rs`
  - Include new artifact schemas if utoipa does not discover them through snapshot structs.
- Modify `crates/ensemble-ui/src-ui/src/hooks.ts`
  - Add artifact fields to the manual `StepDetailSnapshot` interface until Orval types cover them.
- Modify `crates/ensemble-ui/src-ui/src/components/WorkflowStepsSidebar.tsx`
  - Always render step links.
- Create `crates/ensemble-ui/src-ui/src/components/ArtifactsPanel.tsx`
  - Render workspace, repo artifacts, PR links, finalize errors, and transcript links.
- Modify `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
  - Render `ArtifactsPanel` in the Artifacts tab.
- Modify `crates/ensemble-ui/src-ui/src/pages/StepDetail.tsx`
  - Render `ConversationViewer` or an explicit empty transcript state.
- Add or modify tests in the same modules.
- Modify `docs/SPEC.md` and `docs/configuration.md`
  - Document durable artifacts, step log navigation, and `finalize.mode` default `none`.

---

### Task 1: Add Artifact Types to History Records

**Files:**
- Create: `crates/ensemble-core/src/history/artifacts.rs`
- Modify: `crates/ensemble-core/src/history/mod.rs`
- Modify: `crates/ensemble-core/src/history/model.rs`
- Modify: `crates/ensemble-core/src/history/writer.rs`
- Modify: `crates/ensemble-core/src/history/reader.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Modify: `crates/ensemble-core/src/api/history_handler.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/history_store/store.rs`

- [ ] **Step 1: Write the artifact model and history serialization tests**

Add the new file:

```rust
// crates/ensemble-core/src/history/artifacts.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RunArtifacts {
    pub run_id: String,
    pub workspace_path: String,
    pub repos: Vec<RepoArtifact>,
    pub transcripts: Vec<StepTranscriptArtifact>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct StepTranscriptArtifact {
    pub step_name: String,
    pub run_id: String,
    pub record_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FinalizeActionOutput {
    pub pushed_ref: Option<String>,
    pub pr_url: Option<String>,
}
```

Add the module:

```rust
// crates/ensemble-core/src/history/mod.rs
pub mod artifacts;
pub mod model;
pub mod reader;
pub mod writer;
```

Add `artifacts` to `HistoryRecord`:

```rust
// crates/ensemble-core/src/history/model.rs
use crate::history::artifacts::RunArtifacts;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct HistoryRecord {
    pub issue_identifier: String,
    pub issue_id: String,
    pub outcome: String,
    pub steps_traversed: Vec<String>,
    pub attempts: u32,
    pub tokens: TokenTotals,
    pub duration_seconds: u64,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub last_error: Option<String>,
    pub verdict: Option<String>,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<RunArtifacts>,
}
```

Update every `HistoryRecord { ... }` literal in these files by adding `artifacts: None` unless the test is specifically about artifacts:

```text
crates/ensemble-core/src/history/writer.rs
crates/ensemble-core/src/history/reader.rs
crates/ensemble-core/src/api/handlers.rs
crates/ensemble-core/src/api/history_handler.rs
crates/ensemble-core/src/orchestrator/mod.rs
crates/ensemble-core/src/history_store/store.rs
```

Then add this test to `crates/ensemble-core/src/history/writer.rs`:

```rust
#[tokio::test]
async fn append_round_trips_optional_artifacts() {
    let tmp = NamedTempFile::new().unwrap();
    let path = tmp.path().to_path_buf();
    std::fs::remove_file(&path).ok();
    let writer = HistoryWriter::new(path.clone());
    let mut record = sample_record();
    record.artifacts = Some(crate::history::artifacts::RunArtifacts {
        run_id: "run-1".into(),
        workspace_path: "/tmp/workspace/repo-1".into(),
        repos: vec![crate::history::artifacts::RepoArtifact {
            repo: "repo".into(),
            worktree_path: "/tmp/workspace/repo-1/repo".into(),
            base_branch: "main".into(),
            branch: "ensemble/repo-1".into(),
            head_sha: Some("abc123".into()),
            changed_files: vec!["src/lib.rs".into()],
            finalize_mode: "none".into(),
            finalize_status: "not_required".into(),
            pushed_ref: None,
            pr_url: None,
            last_error: None,
        }],
        transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
            step_name: "build".into(),
            run_id: "run-1".into(),
            record_count: 3,
        }],
    });

    writer.append(&record).await.unwrap();

    let contents = tokio::fs::read_to_string(&path).await.unwrap();
    let parsed: HistoryRecord = serde_json::from_str(contents.lines().next().unwrap()).unwrap();
    let artifacts = parsed.artifacts.unwrap();
    assert_eq!(artifacts.run_id, "run-1");
    assert_eq!(artifacts.repos[0].finalize_mode, "none");
    assert_eq!(artifacts.transcripts[0].record_count, 3);
}
```

- [ ] **Step 2: Run the focused history tests and verify the expected failures**

Run:

```bash
rtk cargo test -p ensemble-core history::writer::tests::append_round_trips_optional_artifacts -- --nocapture
```

Expected: FAIL before the model is fully wired, with compile errors about missing `artifacts` fields or missing module imports.

- [ ] **Step 3: Finish the model wiring**

Apply the model/module changes from Step 1 and add `artifacts: None` to all existing `HistoryRecord` literals. For `sample_record()` in `history/writer.rs`, the full body should end with:

```rust
HistoryRecord {
    issue_identifier: "MT-648".into(),
    issue_id: "abc123".into(),
    outcome: "succeeded".into(),
    steps_traversed: vec!["build".into(), "review".into()],
    attempts: 1,
    tokens: TokenTotals {
        input_tokens: 180_000,
        output_tokens: 104_000,
        total_tokens: 284_000,
    },
    duration_seconds: 765,
    started_at: Utc::now(),
    completed_at: Utc::now(),
    last_error: None,
    verdict: Some("approved".into()),
    workspace_path: "/tmp/ensemble_workspaces/MT-648".into(),
    artifacts: None,
}
```

- [ ] **Step 4: Run history model tests**

Run:

```bash
rtk cargo test -p ensemble-core history::writer -- --nocapture
rtk cargo test -p ensemble-core history::reader -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/history/artifacts.rs \
  crates/ensemble-core/src/history/mod.rs \
  crates/ensemble-core/src/history/model.rs \
  crates/ensemble-core/src/history/writer.rs \
  crates/ensemble-core/src/history/reader.rs \
  crates/ensemble-core/src/api/handlers.rs \
  crates/ensemble-core/src/api/history_handler.rs \
  crates/ensemble-core/src/orchestrator/mod.rs \
  crates/ensemble-core/src/history_store/store.rs
rtk git commit -m "Add durable run artifact history model"
```

---

### Task 2: Store Artifacts in SQLite History

**Files:**
- Modify: `crates/ensemble-core/src/history_store/schema.rs`
- Modify: `crates/ensemble-core/src/history_store/model.rs`
- Modify: `crates/ensemble-core/src/history_store/store.rs`

- [ ] **Step 1: Write failing SQLite tests for artifact persistence and migration**

Add to `crates/ensemble-core/src/history_store/store.rs` tests:

```rust
#[tokio::test]
async fn append_history_record_round_trips_artifacts() {
    let dir = tempfile::TempDir::new().unwrap();
    let store = HistoryStore::new(dir.path().join("history.db"))
        .await
        .unwrap();
    let mut record = sample_history("repo#1");
    record.artifacts = Some(crate::history::artifacts::RunArtifacts {
        run_id: "run-1".into(),
        workspace_path: "/tmp/repo-1".into(),
        repos: vec![crate::history::artifacts::RepoArtifact {
            repo: "repo".into(),
            worktree_path: "/tmp/repo-1/repo".into(),
            base_branch: "main".into(),
            branch: "ensemble/repo-1".into(),
            head_sha: Some("abc123".into()),
            changed_files: vec!["Cargo.toml".into()],
            finalize_mode: "push_and_pr".into(),
            finalize_status: "succeeded".into(),
            pushed_ref: Some("origin/ensemble/repo-1".into()),
            pr_url: Some("https://github.com/acme/repo/pull/12".into()),
            last_error: None,
        }],
        transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
            step_name: "build".into(),
            run_id: "run-1".into(),
            record_count: 2,
        }],
    });

    store.append_history_record("run-1", &record).await.unwrap();

    let response = store.read_history(&HistoryQuery::default()).await.unwrap();
    let artifacts = response.records[0].artifacts.as_ref().unwrap();
    assert_eq!(artifacts.repos[0].pr_url.as_deref(), Some("https://github.com/acme/repo/pull/12"));
    assert_eq!(artifacts.transcripts[0].step_name, "build");
}
```

Add to `crates/ensemble-core/src/history_store/schema.rs` tests:

```rust
#[test]
fn bootstrap_adds_artifacts_column_to_existing_runs_table() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            issue_id TEXT NOT NULL,
            issue_identifier TEXT NOT NULL,
            outcome TEXT NOT NULL,
            steps_traversed TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            duration_seconds INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            last_error TEXT,
            verdict TEXT,
            workspace_path TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            total_tokens INTEGER NOT NULL
        );
        "#,
    )
    .unwrap();

    bootstrap_schema(&conn).unwrap();

    let artifacts_column_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'artifacts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(artifacts_column_count, 1);
}
```

- [ ] **Step 2: Run SQLite tests and verify they fail**

Run:

```bash
rtk cargo test -p ensemble-core history_store -- --nocapture
```

Expected: FAIL because the `runs` table has no `artifacts` column and row mapping does not read/write it.

- [ ] **Step 3: Add schema migration and row mapping**

In `schema.rs`, extend `CREATE TABLE` and add migration logic after `execute_batch`:

```rust
pub fn bootstrap_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            issue_id TEXT NOT NULL,
            issue_identifier TEXT NOT NULL,
            outcome TEXT NOT NULL,
            steps_traversed TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            duration_seconds INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            last_error TEXT,
            verdict TEXT,
            workspace_path TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            total_tokens INTEGER NOT NULL,
            artifacts TEXT
        );

        CREATE TABLE IF NOT EXISTS run_events (
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            issue_identifier TEXT NOT NULL,
            event_type TEXT NOT NULL,
            step_name TEXT,
            attempt INTEGER NOT NULL,
            detail TEXT NOT NULL,
            verdict TEXT,
            tool_name TEXT,
            PRIMARY KEY (run_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence ON run_events(run_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_runs_identifier_completed_at ON runs(issue_identifier, completed_at);
        CREATE INDEX IF NOT EXISTS idx_runs_outcome_completed_at ON runs(outcome, completed_at);
        "#,
    )?;

    add_column_if_missing(conn, "runs", "artifacts", "TEXT")?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    column_type: &str,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {column_type}"), [])?;
    Ok(())
}
```

In `model.rs`, parse artifacts:

```rust
let artifacts_json: Option<String> = row.get("artifacts")?;
let artifacts = artifacts_json
    .as_deref()
    .map(serde_json::from_str)
    .transpose()
    .map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(e),
        )
    })?;
```

Then include `artifacts` in the returned `HistoryRecord`.

In `store.rs`, add the column to insert/update/select:

```rust
let artifacts_json = record
    .artifacts
    .as_ref()
    .map(serde_json::to_string)
    .transpose()
    .map_err(io::Error::other)?;
```

Use `artifacts` as `?16`, update `artifacts = excluded.artifacts`, pass `artifacts_json`, and select it in `read_history`.

- [ ] **Step 4: Run SQLite tests**

Run:

```bash
rtk cargo test -p ensemble-core history_store -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add crates/ensemble-core/src/history_store/schema.rs \
  crates/ensemble-core/src/history_store/model.rs \
  crates/ensemble-core/src/history_store/store.rs
rtk git commit -m "Persist run artifacts in history store"
```

---

### Task 3: Collect Baseline Artifacts and Finalize Outputs

**Files:**
- Modify: `crates/ensemble-core/src/history/artifacts.rs`
- Modify: `crates/ensemble-core/src/orchestrator/state.rs`
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`

- [ ] **Step 1: Write artifact collector unit tests**

Add tests to `crates/ensemble-core/src/history/artifacts.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::finalize::FinalizeMode;
    use tempfile::TempDir;

    #[tokio::test]
    async fn collect_repo_artifact_records_none_mode_repo_state() {
        let dir = TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        tokio::fs::create_dir_all(repo.join("src")).await.unwrap();
        run_git(&repo, &["init"]).await;
        run_git(&repo, &["config", "user.email", "test@example.com"]).await;
        run_git(&repo, &["config", "user.name", "Test User"]).await;
        tokio::fs::write(repo.join("src/lib.rs"), "pub fn value() -> i32 { 1 }\n")
            .await
            .unwrap();
        run_git(&repo, &["add", "."]).await;
        run_git(&repo, &["commit", "-m", "initial"]).await;
        run_git(&repo, &["checkout", "-b", "ensemble/repo-1"]).await;
        tokio::fs::write(repo.join("src/lib.rs"), "pub fn value() -> i32 { 2 }\n")
            .await
            .unwrap();

        let artifact = collect_repo_artifact(
            "repo",
            &repo,
            "main",
            &FinalizeMode::None,
            "not_required",
        )
        .await;

        assert_eq!(artifact.repo, "repo");
        assert_eq!(artifact.branch, "ensemble/repo-1");
        assert_eq!(artifact.finalize_mode, "none");
        assert_eq!(artifact.finalize_status, "not_required");
        assert!(artifact.head_sha.is_some());
        assert_eq!(artifact.changed_files, vec!["src/lib.rs"]);
    }

    async fn run_git(repo: &std::path::Path, args: &[&str]) {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
```

- [ ] **Step 2: Run artifact collector test and verify it fails**

Run:

```bash
rtk cargo test -p ensemble-core history::artifacts::tests::collect_repo_artifact_records_none_mode_repo_state -- --nocapture
```

Expected: FAIL because `collect_repo_artifact` is not implemented.

- [ ] **Step 3: Implement focused git collection helpers**

Add to `history/artifacts.rs`:

```rust
use crate::workspace::finalize::FinalizeMode;
use std::path::Path;

pub fn finalize_mode_name(mode: &FinalizeMode) -> &'static str {
    match mode {
        FinalizeMode::None => "none",
        FinalizeMode::Push => "push",
        FinalizeMode::PushAndPr => "push_and_pr",
    }
}

pub async fn collect_repo_artifact(
    repo: &str,
    worktree_path: &Path,
    base_branch: &str,
    finalize_mode: &FinalizeMode,
    finalize_status: &str,
) -> RepoArtifact {
    RepoArtifact {
        repo: repo.to_string(),
        worktree_path: worktree_path.display().to_string(),
        base_branch: base_branch.to_string(),
        branch: git_stdout(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .unwrap_or_default(),
        head_sha: git_stdout(worktree_path, &["rev-parse", "HEAD"]).await,
        changed_files: collect_changed_files(worktree_path).await,
        finalize_mode: finalize_mode_name(finalize_mode).to_string(),
        finalize_status: finalize_status.to_string(),
        pushed_ref: None,
        pr_url: None,
        last_error: None,
    }
}

async fn collect_changed_files(worktree_path: &Path) -> Vec<String> {
    let Some(output) = git_stdout(worktree_path, &["status", "--porcelain=v1"]).await else {
        return Vec::new();
    };

    let mut files: Vec<String> = output
        .lines()
        .filter_map(|line| line.get(3..))
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
        .collect();
    files.sort();
    files.dedup();
    files
}

async fn git_stdout(worktree_path: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
```

- [ ] **Step 4: Add in-memory artifact state**

In `orchestrator/state.rs`, import the type:

```rust
use crate::history::artifacts::RunArtifacts;
```

Add a field:

```rust
/// Durable run artifacts collected before history is written.
pub artifacts: HashMap<String, RunArtifacts>,
```

Initialize it in `OrchestratorState::new`:

```rust
artifacts: HashMap::new(),
```

Remove it from `release_claim`:

```rust
self.artifacts.remove(issue_id);
```

- [ ] **Step 5: Change finalize action to return structured output**

In `orchestrator/mod.rs`, import:

```rust
use crate::history::artifacts::{FinalizeActionOutput, RunArtifacts};
```

Change `execute_finalize_action` signature:

```rust
async fn execute_finalize_action(
    &self,
    repo_path: &std::path::Path,
    remote: &str,
    base_branch: &str,
    mode: &FinalizeMode,
) -> Result<FinalizeActionOutput, String>
```

After successful push, build the pushed ref from current branch:

```rust
let current_branch = Self::current_branch(repo_path).await?;
let pushed_ref = Some(format!("{remote}/{current_branch}"));
let mut output = FinalizeActionOutput {
    pushed_ref,
    pr_url: None,
};
```

For `PushAndPr`, set `output.pr_url` from `gh pr create` stdout or existing PR lookup. Add helper:

```rust
async fn current_branch(repo_path: &std::path::Path) -> Result<String, String> {
    let branch_output = tokio::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|error| format!("failed to resolve branch: {error}"))?;
    if !branch_output.status.success() {
        return Err(format!(
            "failed to resolve current branch: {}",
            String::from_utf8_lossy(&branch_output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&branch_output.stdout).trim().to_string())
}

fn parse_first_pr_url(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some(trimmed.lines().next().unwrap_or(trimmed).trim().to_string());
    }
    serde_json::from_str::<Vec<serde_json::Value>>(trimmed)
        .ok()
        .and_then(|values| values.first().and_then(|value| value.get("url")))
        .and_then(|url| url.as_str())
        .map(ToString::to_string)
}
```

Return `Ok(output)` instead of `Ok(())`.

- [ ] **Step 6: Update finalize callers**

Where code currently matches `Ok(())`, change to `Ok(output)` and store output on the matching repo artifact:

```rust
Ok(output) => {
    if let Some(artifacts) = state.artifacts.get_mut(issue_id) {
        if let Some(repo_artifact) = artifacts.repos.iter_mut().find(|artifact| artifact.repo == repo_name) {
            repo_artifact.finalize_status = "succeeded".to_string();
            repo_artifact.pushed_ref = output.pushed_ref;
            repo_artifact.pr_url = output.pr_url;
            repo_artifact.last_error = None;
        }
    }
}
```

Use the same update pattern in initial finalize and finalize retry paths. For errors, set `finalize_status = "failed"` and `last_error = Some(error.clone())`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
rtk cargo test -p ensemble-core history::artifacts -- --nocapture
rtk cargo test -p ensemble-core orchestrator:: -- --nocapture
```

Expected: PASS or existing long-running orchestrator tests pass. If an existing orchestrator test is too broad locally, run the specific tests that fail to compile first and fix all compile errors.

- [ ] **Step 8: Commit**

```bash
rtk git add crates/ensemble-core/src/history/artifacts.rs \
  crates/ensemble-core/src/orchestrator/state.rs \
  crates/ensemble-core/src/orchestrator/mod.rs
rtk git commit -m "Collect run artifacts during orchestration"
```

---

### Task 4: Attach Artifacts to History and API Snapshots

**Files:**
- Modify: `crates/ensemble-core/src/orchestrator/mod.rs`
- Modify: `crates/ensemble-core/src/observability/snapshot.rs`
- Modify: `crates/ensemble-core/src/api/handlers.rs`
- Modify: `crates/ensemble-core/src/api/openapi.rs`

- [ ] **Step 1: Write failing snapshot/API tests**

In `crates/ensemble-core/src/api/handlers.rs`, add a history-backed issue test:

```rust
#[tokio::test]
async fn history_backed_issue_detail_includes_artifacts_and_navigable_steps() {
    let tmp = tempfile::TempDir::new().unwrap();
    let history_path = tmp.path().join("ensemble_history.jsonl");
    let writer = HistoryWriter::new(history_path.clone());
    writer
        .append(&HistoryRecord {
            issue_identifier: "repo#77".into(),
            issue_id: "NODE_77".into(),
            outcome: "succeeded".into(),
            steps_traversed: vec!["build".into()],
            attempts: 1,
            tokens: TokenTotals {
                input_tokens: 1,
                output_tokens: 2,
                total_tokens: 3,
            },
            duration_seconds: 10,
            started_at: Utc::now(),
            completed_at: Utc::now(),
            last_error: None,
            verdict: Some("approved".into()),
            workspace_path: tmp.path().join("repo-77").display().to_string(),
            artifacts: Some(crate::history::artifacts::RunArtifacts {
                run_id: "run-77".into(),
                workspace_path: tmp.path().join("repo-77").display().to_string(),
                repos: Vec::new(),
                transcripts: vec![crate::history::artifacts::StepTranscriptArtifact {
                    step_name: "build".into(),
                    run_id: "run-77".into(),
                    record_count: 5,
                }],
            }),
        })
        .await
        .unwrap();

    let mut app_state = build_empty_state();
    app_state.history_path = history_path;
    app_state.workspace_root = tmp.path().display().to_string();

    let response = get_issue_detail(State(app_state), Path("repo#77".to_string())).await;
    let body = axum::body::to_bytes(response.into_response().into_body(), usize::MAX)
        .await
        .unwrap();
    let detail: IssueDetailSnapshot = serde_json::from_slice(&body).unwrap();

    assert_eq!(detail.artifacts.as_ref().unwrap().run_id, "run-77");
    assert!(detail.workflow_steps[0].can_navigate);
}
```

In `observability/snapshot.rs` tests, add a unit test for active/completed snapshots:

```rust
#[tokio::test]
async fn issue_snapshot_includes_in_memory_artifacts() {
    let mut state = OrchestratorState::new(30000, &ConcurrencyConfig::default());
    state.artifacts.insert(
        "NODE_1".into(),
        crate::history::artifacts::RunArtifacts {
            run_id: "run-1".into(),
            workspace_path: "/tmp/workspace".into(),
            repos: Vec::new(),
            transcripts: Vec::new(),
        },
    );
    state.completed.insert(
        "NODE_1".into(),
        CompletedEntry {
            issue_id: "NODE_1".into(),
            identifier: "repo#1".into(),
            run_id: Some("run-1".into()),
            issue: crate::tracker::model::Issue {
                id: "NODE_1".into(),
                identifier: "repo#1".into(),
                title: "Issue".into(),
                description: None,
                priority: None,
                state: "Done".into(),
                branch_name: None,
                url: None,
                labels: vec![],
                blocked_by: vec![],
                created_at: None,
                updated_at: None,
            },
            status: "completed_succeeded".into(),
            workflow_steps: vec![],
            completed_at: Utc::now(),
            outcome_summary: None,
        },
    );

    let snapshot = build_issue_snapshot(
        &state,
        "repo#1",
        "/tmp",
        None,
    )
    .await
    .unwrap();

    assert_eq!(snapshot.artifacts.unwrap().run_id, "run-1");
}
```

- [ ] **Step 2: Run snapshot/API tests and verify they fail**

Run:

```bash
rtk cargo test -p ensemble-core history_backed_issue_detail_includes_artifacts_and_navigable_steps -- --nocapture
rtk cargo test -p ensemble-core issue_snapshot_includes_in_memory_artifacts -- --nocapture
```

Expected: FAIL because `IssueDetailSnapshot.artifacts` is missing and history-backed workflow steps are still not artifact-aware.

- [ ] **Step 3: Add artifacts to snapshot structs**

In `observability/snapshot.rs`, import:

```rust
use crate::history::artifacts::{RunArtifacts, StepTranscriptArtifact};
```

Add fields:

```rust
pub struct IssueDetailSnapshot {
    // existing fields
    pub artifacts: Option<RunArtifacts>,
}

pub struct StepDetailSnapshot {
    // existing fields
    pub run_id: Option<String>,
    pub transcript: Option<StepTranscriptArtifact>,
}
```

When building issue snapshots, set:

```rust
let artifacts = state.artifacts.get(&issue_id).cloned();
```

and include `artifacts` in `IssueDetailSnapshot`.

For history-backed snapshots in `api/handlers.rs`, include:

```rust
let artifacts = record.artifacts.clone();
```

Set history-backed `WorkflowStepInfo.can_navigate` to true for every step:

```rust
can_navigate: true,
```

Include `artifacts` in the returned `IssueDetailSnapshot`.

- [ ] **Step 4: Add step transcript metadata**

In `get_step_detail`, after `recent_events`, derive transcript metadata from the detail run id:

```rust
let transcript = if let Some(ref run_id) = detail_state.run_id {
    match crate::transcript::reader::read_transcript_page(
        FsPath::new(&state.workspace_root),
        run_id,
        &step_name,
        None,
        Some(1),
    )
    .await
    {
        Ok(response) if response.total > 0 => Some(crate::history::artifacts::StepTranscriptArtifact {
            step_name: step_name.clone(),
            run_id: run_id.clone(),
            record_count: response.total,
        }),
        _ => None,
    }
} else {
    None
};
```

Include:

```rust
run_id: detail_state.run_id,
transcript,
```

in `StepDetailSnapshot`.

- [ ] **Step 5: Register new schemas if needed**

In `api/openapi.rs`, ensure these schemas are included if the OpenAPI compile test fails:

```rust
crate::history::artifacts::RunArtifacts,
crate::history::artifacts::RepoArtifact,
crate::history::artifacts::StepTranscriptArtifact,
```

- [ ] **Step 6: Run API/snapshot tests**

Run:

```bash
rtk cargo test -p ensemble-core history_backed_issue_detail_includes_artifacts_and_navigable_steps -- --nocapture
rtk cargo test -p ensemble-core issue_snapshot_includes_in_memory_artifacts -- --nocapture
rtk cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored
```

Expected: PASS.

- [ ] **Step 7: Regenerate frontend API models**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm run codegen
```

Expected: PASS and generated TypeScript models include `RunArtifacts`, `RepoArtifact`, and `StepTranscriptArtifact`.

- [ ] **Step 8: Commit**

```bash
rtk git add crates/ensemble-core/src/orchestrator/mod.rs \
  crates/ensemble-core/src/observability/snapshot.rs \
  crates/ensemble-core/src/api/handlers.rs \
  crates/ensemble-core/src/api/openapi.rs \
  crates/ensemble-ui/src-ui/src/generated
rtk git commit -m "Expose run artifacts in issue and step APIs"
```

---

### Task 5: Render Artifacts and Always-Clickable Workflow Steps

**Files:**
- Create: `crates/ensemble-ui/src-ui/src/components/ArtifactsPanel.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/components/WorkflowStepsSidebar.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add to `IssueDetail.test.tsx`:

```tsx
it("renders durable artifacts and keeps workflow steps clickable when can_navigate is false", () => {
  hooksMock.useIssueDetailQuery.mockReturnValueOnce({
    data: {
      issue_identifier: "todo-1",
      issue_id: "NODE_1",
      status: "completed_succeeded",
      running: null,
      attempts: { restart_count: 0, current_retry_attempt: null },
      retry: null,
      pending_input: null,
      current_interaction: null,
      last_error: null,
      issue: { title: "Deploy feature", labels: [] },
      workspace: { path: "/tmp/workspace" },
      finalize: { status: "not_required", repos: [] },
      artifacts: {
        run_id: "run-1",
        workspace_path: "/tmp/workspace",
        repos: [
          {
            repo: "repo",
            worktree_path: "/tmp/workspace/repo",
            base_branch: "main",
            branch: "ensemble/todo-1",
            head_sha: "abc123",
            changed_files: ["src/lib.rs"],
            finalize_mode: "push_and_pr",
            finalize_status: "succeeded",
            pushed_ref: "origin/ensemble/todo-1",
            pr_url: "https://github.com/acme/repo/pull/1",
            last_error: null,
          },
        ],
        transcripts: [{ step_name: "deploy", run_id: "run-1", record_count: 4 }],
      },
      workflow_steps: [
        {
          name: "deploy",
          agent: "builder",
          kind: "agent",
          dependencies: [],
          state: "passed",
          can_navigate: false,
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
  });

  renderWithProviders(
    <MemoryRouter initialEntries={["/issue/todo-1"]}>
      <Routes>
        <Route path="/issue/:identifier" element={<IssueDetail />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByText("/tmp/workspace")).toBeInTheDocument();
  expect(screen.getByText("ensemble/todo-1")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /pull request/i })).toHaveAttribute(
    "href",
    "https://github.com/acme/repo/pull/1",
  );
  expect(screen.getByRole("link", { name: "deploy" })).toHaveAttribute(
    "href",
    "/issue/todo-1/step/deploy",
  );
});
```

- [ ] **Step 2: Run UI test and verify it fails**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm test -- IssueDetail.test.tsx
```

Expected: FAIL because there is no `ArtifactsPanel` and `WorkflowStepsSidebar` disables links when `can_navigate` is false.

- [ ] **Step 3: Create `ArtifactsPanel`**

```tsx
// crates/ensemble-ui/src-ui/src/components/ArtifactsPanel.tsx
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RunArtifacts } from "@/generated/models";

interface ArtifactsPanelProps {
  identifier: string;
  workspacePath: string;
  artifacts?: RunArtifacts | null;
}

export default function ArtifactsPanel({
  identifier,
  workspacePath,
  artifacts,
}: ArtifactsPanelProps) {
  const effectiveWorkspace = artifacts?.workspace_path ?? workspacePath;
  const repos = artifacts?.repos ?? [];
  const transcripts = artifacts?.transcripts ?? [];

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="font-medium">Workspace</div>
        <code className="mt-2 block rounded bg-background px-2 py-1 text-xs">
          {effectiveWorkspace}
        </code>
      </div>

      {repos.map((repo) => (
        <div key={repo.repo} className="rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium">{repo.repo}</div>
            <Badge variant="outline">{repo.finalize_status}</Badge>
          </div>
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <div>Branch: <span className="text-foreground">{repo.branch}</span></div>
            <div>Base: <span className="text-foreground">{repo.base_branch}</span></div>
            {repo.head_sha ? <div>HEAD: <span className="text-foreground">{repo.head_sha}</span></div> : null}
            <div>Finalize: <span className="text-foreground">{repo.finalize_mode}</span></div>
            {repo.pushed_ref ? <div>Pushed: <span className="text-foreground">{repo.pushed_ref}</span></div> : null}
          </div>
          {repo.pr_url ? (
            <Button asChild variant="outline" size="sm" className="mt-3">
              <a href={repo.pr_url} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                Pull request
              </a>
            </Button>
          ) : null}
          {repo.changed_files.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs">
              {repo.changed_files.map((file) => (
                <li key={file}>
                  <code className="rounded bg-background px-1 py-0.5">{file}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {repo.last_error ? (
            <p className="mt-3 whitespace-pre-wrap text-xs text-destructive">{repo.last_error}</p>
          ) : null}
        </div>
      ))}

      {transcripts.length > 0 ? (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="font-medium">Step transcripts</div>
          <div className="mt-2 space-y-2">
            {transcripts.map((transcript) => (
              <Link
                key={transcript.step_name}
                to={`/issue/${encodeURIComponent(identifier)}/step/${encodeURIComponent(transcript.step_name)}`}
                className="flex items-center justify-between rounded border bg-background px-2 py-1 text-xs hover:bg-muted"
              >
                <span>{transcript.step_name}</span>
                <span className="text-muted-foreground">{transcript.record_count} records</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Make workflow steps always clickable**

In `WorkflowStepsSidebar.tsx`, replace the conditional `step.can_navigate ? <Link> : <span>` with:

```tsx
<Link
  to={`/issue/${encodeURIComponent(issueIdentifier)}/step/${encodeURIComponent(step.name)}`}
  className={`text-sm hover:underline ${isActive ? "font-semibold text-primary" : "text-muted-foreground"}`}
>
  {step.name}
</Link>
```

Keep `can_navigate` in the TypeScript interface to avoid unnecessary API churn, but do not use it to disable the link.

- [ ] **Step 5: Use `ArtifactsPanel` in issue detail**

In `IssueDetail.tsx`, import:

```tsx
import ArtifactsPanel from "@/components/ArtifactsPanel";
```

Replace `artifactsPanel` body with:

```tsx
const artifactsPanel = (
  <div className="space-y-3">
    <ArtifactsPanel
      identifier={identifier}
      workspacePath={data.workspace.path}
      artifacts={data.artifacts ?? null}
    />
    {data.issue ? <IssueInfoSection issue={data.issue} /> : null}
  </div>
);
```

- [ ] **Step 6: Run UI test**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm test -- IssueDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add crates/ensemble-ui/src-ui/src/components/ArtifactsPanel.tsx \
  crates/ensemble-ui/src-ui/src/components/WorkflowStepsSidebar.tsx \
  crates/ensemble-ui/src-ui/src/pages/IssueDetail.tsx \
  crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx
rtk git commit -m "Show durable artifacts on issue detail"
```

---

### Task 6: Render Step Transcripts and Empty Log States

**Files:**
- Modify: `crates/ensemble-ui/src-ui/src/hooks.ts`
- Modify: `crates/ensemble-ui/src-ui/src/pages/StepDetail.tsx`
- Modify: `crates/ensemble-ui/src-ui/src/pages/IssueDetail.test.tsx`
- Add: `crates/ensemble-ui/src-ui/src/pages/StepDetail.test.tsx` if it does not already exist.

- [ ] **Step 1: Write failing step detail tests**

Create `crates/ensemble-ui/src-ui/src/pages/StepDetail.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StepDetail from "./StepDetail";

const hooksMock = vi.hoisted(() => ({
  useStepDetailQuery: vi.fn(),
  useStepConversationQuery: vi.fn(),
}));

vi.mock("@/hooks", () => hooksMock);

describe("StepDetail", () => {
  it("renders the transcript viewer when transcript metadata exists", () => {
    hooksMock.useStepDetailQuery.mockReturnValue({
      data: {
        issue_identifier: "todo-1",
        issue_id: "NODE_1",
        step_name: "build",
        status: "passed",
        agent: "builder",
        kind: "agent",
        dependencies: [],
        can_navigate: true,
        verdict: "success",
        recent_events: [],
        run_id: "run-1",
        transcript: { step_name: "build", run_id: "run-1", record_count: 1 },
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useStepConversationQuery.mockReturnValue({
      data: {
        records: [
          {
            schema_version: 1,
            run_id: "run-1",
            issue_identifier: "todo-1",
            step_name: "build",
            attempt: 1,
            sequence: 1,
            timestamp: "2026-06-16T10:00:00Z",
            kind: "assistant_message",
            payload: { text: "Build complete" },
          },
        ],
        total: 1,
        next_cursor: null,
      },
      isLoading: false,
      isError: false,
    });

    render(
      <MemoryRouter initialEntries={["/issue/todo-1/step/build"]}>
        <Routes>
          <Route path="/issue/:identifier/step/:stepName" element={<StepDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Build complete")).toBeInTheDocument();
  });

  it("renders an empty log state when no transcript exists", () => {
    hooksMock.useStepDetailQuery.mockReturnValue({
      data: {
        issue_identifier: "todo-1",
        issue_id: "NODE_1",
        step_name: "pending-step",
        status: "pending",
        agent: "builder",
        kind: "agent",
        dependencies: [],
        can_navigate: true,
        verdict: null,
        recent_events: [],
        run_id: null,
        transcript: null,
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    hooksMock.useStepConversationQuery.mockReturnValue({
      data: { records: [], total: 0, next_cursor: null },
      isLoading: false,
      isError: false,
    });

    render(
      <MemoryRouter initialEntries={["/issue/todo-1/step/pending-step"]}>
        <Routes>
          <Route path="/issue/:identifier/step/:stepName" element={<StepDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("No transcript recorded for this step yet.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run step detail tests and verify they fail**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm test -- StepDetail.test.tsx
```

Expected: FAIL because `StepDetail` does not render `ConversationViewer` or an empty transcript state.

- [ ] **Step 3: Extend manual StepDetail interface**

In `hooks.ts`, add:

```ts
export interface StepTranscriptArtifact {
  step_name: string;
  run_id: string;
  record_count: number;
}
```

Extend `StepDetailSnapshot`:

```ts
run_id?: string | null;
transcript?: StepTranscriptArtifact | null;
```

- [ ] **Step 4: Render transcript or empty state in `StepDetail`**

In `StepDetail.tsx`, import:

```tsx
import ConversationViewer from "@/components/ConversationViewer";
```

Add below Recent Events:

```tsx
<section>
  <h2 className="mb-3 text-lg font-semibold">Transcript</h2>
  <Card className="p-4">
    {data.run_id && data.transcript ? (
      <ConversationViewer
        identifier={identifier}
        runId={data.run_id}
        stepName={data.step_name}
      />
    ) : (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No transcript recorded for this step yet.
      </div>
    )}
  </Card>
</section>
```

- [ ] **Step 5: Run step detail tests**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm test -- StepDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add crates/ensemble-ui/src-ui/src/hooks.ts \
  crates/ensemble-ui/src-ui/src/pages/StepDetail.tsx \
  crates/ensemble-ui/src-ui/src/pages/StepDetail.test.tsx
rtk git commit -m "Show step transcripts on step detail"
```

---

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Update docs**

Add to `docs/configuration.md` near repo finalize settings:

```markdown
`repos[].finalize.mode` defaults to `none`. With this default, Ensemble records
durable run artifacts for the issue but does not push branches or open pull
requests. Set `mode: push` or `mode: push_and_pr` per repo when publication is
desired.
```

Add to `docs/SPEC.md` in the dashboard/API behavior section:

```markdown
Every run records a durable artifact bundle containing the run id, workspace
path, per-repo branch/head/change metadata, finalize status, publication links
when available, and transcript pointers per workflow step. Issue detail
responses expose these artifacts for active and history-backed completed issues.

Workflow steps are stable navigation targets. The dashboard links every step on
the issue detail page to a step detail route regardless of current state. If no
transcript exists for a step, the step detail page shows an explicit empty log
state instead of disabling navigation.
```

- [ ] **Step 2: Verify OpenAPI and frontend client generation remains clean**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm run codegen
```

Expected: PASS with no unexpected generated diffs beyond files already committed in Task 4.

- [ ] **Step 3: Run focused Rust checks**

Run:

```bash
rtk cargo test -p ensemble-core history::writer -- --nocapture
rtk cargo test -p ensemble-core history::reader -- --nocapture
rtk cargo test -p ensemble-core history_store -- --nocapture
rtk cargo test -p ensemble-core --test openapi_spec write_openapi_spec -- --ignored
```

Expected: PASS.

- [ ] **Step 4: Run focused UI checks**

Run:

```bash
cd crates/ensemble-ui/src-ui && pnpm test -- IssueDetail.test.tsx StepDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run required pre-push checks for touched areas**

Run:

```bash
rtk cargo test --workspace --exclude ensemble-desktop
rtk env SKIP_UI_BUILD=1 cargo check -p ensemble-cli --features web-ui
rtk cargo clippy --workspace --exclude ensemble-desktop -- -D warnings
rtk cargo fmt --all -- --check
cd crates/ensemble-ui/src-ui && pnpm test
cd crates/ensemble-ui/src-ui && pnpm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add docs/SPEC.md docs/configuration.md
rtk git commit -m "Document durable run artifacts"
```

---

## Self-Review Checklist

- Spec coverage:
  - Durable artifact model: Task 1.
  - SQLite/history durability: Task 2.
  - Baseline and finalize artifact collection: Task 3.
  - API issue/step snapshots: Task 4.
  - Dashboard artifact panel and always-clickable workflow steps: Task 5.
  - Step transcript viewer and empty state: Task 6.
  - Docs and verification: Task 7.
- No incomplete steps: all implementation steps include exact paths, code, commands, and expected results.
- Type consistency:
  - `RunArtifacts`, `RepoArtifact`, and `StepTranscriptArtifact` are defined once in `history/artifacts.rs`.
  - API and UI use `artifacts`, `run_id`, and `transcript` consistently.
  - `FinalizeActionOutput` is intentionally not serialized; it is an internal orchestrator result.
