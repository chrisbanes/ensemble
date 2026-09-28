"""Disposable SQLite-only S01 state-boundary feasibility checks."""

import json
import os
import sqlite3
import sys
import time


root = os.path.abspath(sys.argv[1])
os.makedirs(root, exist_ok=False)
db_path = os.path.join(root, "state.sqlite")
trace = open(os.path.join(root, "trace.jsonl"), "w")


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **fields}) + "\n")
    trace.flush()


def connect():
    connection = sqlite3.connect(db_path, timeout=5, isolation_level=None)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    return connection


db = connect()
db.executescript("""
CREATE TABLE project (id TEXT PRIMARY KEY, paused INTEGER NOT NULL);
CREATE TABLE assignment (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, initialized INTEGER NOT NULL,
  policy_ready INTEGER NOT NULL, stopped INTEGER NOT NULL,
  generation TEXT UNIQUE, writer_hold INTEGER NOT NULL, capacity_hold INTEGER NOT NULL,
  work_revision INTEGER NOT NULL
);
CREATE TABLE submission (
  operation TEXT PRIMARY KEY, assignment_id TEXT UNIQUE NOT NULL,
  generation TEXT UNIQUE NOT NULL
);
CREATE TABLE result_event (
  event_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL,
  disposition TEXT NOT NULL, caused_operation TEXT UNIQUE NOT NULL,
  acknowledged INTEGER NOT NULL
);
""")
db.executemany("INSERT INTO project VALUES (?, ?)", [("startup", 0), ("A", 1), ("B", 0), ("stop", 0)])


def assignment(identifier, project, initialized=1, policy_ready=1, stopped=0):
    db.execute("INSERT INTO assignment VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 1)",
               (identifier, project, initialized, policy_ready, stopped))


def admit(identifier, operation, generation, revision=1):
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("""SELECT a.initialized, a.policy_ready, a.stopped,
                           a.generation, a.writer_hold, a.capacity_hold,
                           a.work_revision, p.paused
                           FROM assignment a JOIN project p ON a.project_id=p.id
                           WHERE a.id=?""", (identifier,)).fetchone()
        active = db.execute("SELECT count(*) FROM assignment WHERE capacity_hold=1").fetchone()[0]
        accepted = row == (1, 1, 0, None, 0, 0, revision, 0) and active < 3
        if accepted:
            db.execute("UPDATE assignment SET generation=?, writer_hold=1, capacity_hold=1 WHERE id=?",
                       (generation, identifier))
            db.execute("INSERT INTO submission VALUES (?, ?, ?)",
                       (operation, identifier, generation))
        db.execute("COMMIT")
        emit(case=identifier, operation=operation, accepted=accepted, active_before=active, row_before=row)
        return accepted
    except Exception:
        db.execute("ROLLBACK")
        raise


assignment("startup-task", "startup", initialized=0, policy_ready=0)
assert not admit("startup-task", "startup-before-init", "g-before-init")
db.execute("UPDATE assignment SET initialized=1 WHERE id='startup-task'")
assert not admit("startup-task", "startup-before-policy", "g-before-policy")
db.execute("UPDATE assignment SET policy_ready=1 WHERE id='startup-task'")
db.execute("""CREATE TRIGGER fail_submission BEFORE INSERT ON submission
              WHEN NEW.operation='storage-fail' BEGIN SELECT RAISE(ABORT, 'synthetic storage fault'); END""")
try:
    admit("startup-task", "storage-fail", "g-storage-fail")
    raise AssertionError("storage fault did not abort admission")
except sqlite3.IntegrityError:
    pass
assert db.execute("SELECT generation,writer_hold,capacity_hold FROM assignment WHERE id='startup-task'").fetchone() == (None, 0, 0)
assert db.execute("SELECT count(*) FROM submission").fetchone()[0] == 0
emit(case="storage_rollback", assignment_held=False, submission_count=0)
db.execute("DROP TRIGGER fail_submission")
assert admit("startup-task", "startup-after-recovery", "g-startup")
assert not admit("startup-task", "duplicate-startup", "g-duplicate")

assignment("A-first", "A")
assignment("A-followup", "A")
assignment("B-first", "B")
assert not admit("A-first", "A-paused-first", "g-A-paused")
assert not admit("A-followup", "A-paused-followup", "g-A-followup")
assert admit("B-first", "B-continues", "g-B")
db.close()
db = connect()
assert db.execute("SELECT paused FROM project WHERE id='A'").fetchone() == (1,)
assert db.execute("SELECT count(*) FROM submission WHERE assignment_id LIKE 'A-%'").fetchone()[0] == 0
db.execute("UPDATE project SET paused=0 WHERE id='A'")
assert admit("A-first", "A-resumed", "g-A")
assert not admit("A-followup", "A-capacity-full", "g-A-overcapacity")
emit(case="pause_restart_capacity", A_submissions=1, B_submissions=1, capacity_holds=3)

assignment("stop-active", "stop")
# Independent stopped generation: simulate a committed admission and its durable hold.
db.execute("UPDATE assignment SET generation='g-stop', writer_hold=1, capacity_hold=1 WHERE id='stop-active'")
db.execute("INSERT INTO submission VALUES ('stop-original', 'stop-active', 'g-stop')")
assignment("stop-followup", "stop", stopped=1)
db.execute("UPDATE assignment SET stopped=1 WHERE id='stop-active'")
emit(case="stop_committed_before_delivery", generation="g-stop", stop_hold=True)
db.close()  # Crash before any cancellation-delivery record.
db = connect()
assert not admit("stop-active", "stop-duplicate", "g-stop-duplicate")
assert not admit("stop-followup", "stop-followup", "g-stop-followup")
assert db.execute("SELECT stopped,writer_hold,capacity_hold FROM assignment WHERE id='stop-active'").fetchone() == (1, 1, 1)
emit(case="stop_reopened", replacement=False, followup=False, holds=(1, 1, 1))

db.execute("INSERT INTO result_event VALUES ('event-1', 'A-first', 'recorded', 'continuation-1', 0)")
db.close()  # Crash before inbox acknowledgement.
db = connect()
db.execute("BEGIN IMMEDIATE")
db.execute("INSERT OR IGNORE INTO result_event VALUES ('event-1', 'A-first', 'recorded', 'continuation-2', 0)")
row = db.execute("SELECT event_id, disposition, caused_operation, acknowledged FROM result_event WHERE event_id='event-1'").fetchone()
assert row == ("event-1", "recorded", "continuation-1", 0)
db.execute("UPDATE result_event SET acknowledged=1 WHERE event_id='event-1'")
db.execute("COMMIT")
assert db.execute("SELECT count(*) FROM result_event").fetchone()[0] == 1
assert db.execute("UPDATE assignment SET policy_ready=0 WHERE id='A-first' AND work_revision=0").rowcount == 0
emit(case="lost_ack_redelivery", event=row, events=1, stale_revision_applied=False)

integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
assert integrity == "ok"
emit(result="sqlite_boundaries_passed", integrity=integrity,
     submissions=db.execute("SELECT count(*) FROM submission").fetchone()[0],
     events=db.execute("SELECT count(*) FROM result_event").fetchone()[0])
db.close()
trace.close()
