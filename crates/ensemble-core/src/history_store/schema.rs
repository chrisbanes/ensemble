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
    )
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
}
