use rusqlite::Connection;

pub fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "busy_timeout", 5000i64)?;
    Ok(())
}

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
            artifacts TEXT,
            acceptance_attempts TEXT
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

        CREATE TABLE IF NOT EXISTS attention_items (
            producer_key TEXT NOT NULL,
            subject_ref TEXT NOT NULL,
            kind TEXT NOT NULL,
            summary TEXT NOT NULL,
            remedy TEXT NOT NULL,
            references_json TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            state TEXT NOT NULL,
            opened_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            closed_at TEXT,
            superseding_identity_json TEXT,
            PRIMARY KEY (producer_key, subject_ref, kind)
        );

        CREATE TABLE IF NOT EXISTS attention_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            producer_key TEXT NOT NULL,
            subject_ref TEXT NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            superseding_identity_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_attention_items_open_updated
            ON attention_items(state, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_attention_items_subject_open
            ON attention_items(subject_ref, state, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_attention_events_identity_sequence
            ON attention_events(producer_key, subject_ref, kind, sequence);
        "#,
    )?;
    add_column_if_missing(conn, "runs", "artifacts", "TEXT")?;
    add_column_if_missing(conn, "runs", "acceptance_attempts", "TEXT")?;
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
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {column_type}"),
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn bootstrap_creates_runs_and_run_events_tables() {
        let conn = Connection::open_in_memory().unwrap();
        apply_pragmas(&conn).unwrap();
        bootstrap_schema(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert!(names.contains(&"runs".to_string()));
        assert!(names.contains(&"run_events".to_string()));
    }

    #[test]
    fn bootstrap_creates_run_events_sequence_index() {
        let conn = Connection::open_in_memory().unwrap();
        apply_pragmas(&conn).unwrap();
        bootstrap_schema(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_run_events_run_sequence'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(count, 1);
    }

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
        let acceptance_column_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name = 'acceptance_attempts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(acceptance_column_count, 1);
    }
}
