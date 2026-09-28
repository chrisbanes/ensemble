"""Deterministic SQLite checks for stale callbacks and ambiguous binding loss."""

import json
import os
import sqlite3
import sys
import time

root = os.path.abspath(sys.argv[1])
os.mkdir(root)
trace = open(os.path.join(root, "trace.jsonl"), "w")
database = os.path.join(root, "state.sqlite")


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **fields}) + "\n")
    trace.flush()


def connect():
    db = sqlite3.connect(database, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    return db


db = connect()
db.executescript("""
CREATE TABLE execution (
 assignment TEXT PRIMARY KEY, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
 thread_id TEXT, turn_id TEXT, operation TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL, writer_hold INTEGER NOT NULL, capacity_hold INTEGER NOT NULL
);
CREATE TABLE callback_binding (
 thread_id TEXT PRIMARY KEY, assignment TEXT NOT NULL,
 generation INTEGER NOT NULL, active INTEGER NOT NULL
);
CREATE TABLE dispatch (operation TEXT PRIMARY KEY, count INTEGER NOT NULL);
""")
db.execute("INSERT INTO execution VALUES ('A',2,7,'thread-A',NULL,'op-A','uncertain',1,1)")
db.execute("INSERT INTO callback_binding VALUES ('thread-A','A',2,1)")
db.execute("INSERT INTO dispatch VALUES ('op-A',1)")
emit(case="intent_and_dispatch_committed", row=db.execute("SELECT * FROM execution").fetchone())


def authorize(thread, generation, claimed_assignment):
    binding = db.execute("SELECT assignment,generation,active FROM callback_binding WHERE thread_id=?", (thread,)).fetchone()
    result = bool(binding and binding == (claimed_assignment, generation, 1))
    emit(case="callback", trusted_thread=thread, supplied_generation=generation,
         claimed_assignment=claimed_assignment, accepted=result,
         binding=binding)
    return result


assert authorize("thread-A", 2, "A")
assert not authorize("thread-A", 2, "B")  # Payload spoof.
assert not authorize("thread-A", 1, "A")  # Old generation.
assert not authorize("unbound-thread", 2, "A")
db.execute("UPDATE callback_binding SET active=0 WHERE thread_id='thread-A'")
assert not authorize("thread-A", 2, "A")  # Late callback after invalidation.
db.close()


def reconcile(case, observed, expected_binding):
    connection = connect()
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute("SELECT generation,revision,thread_id,turn_id,operation,state,writer_hold,capacity_hold FROM execution WHERE assignment='A'").fetchone()
    generation, revision, thread, turn, operation, state, writer, capacity = row
    assert state == "uncertain" and writer == capacity == 1
    matches = [item for item in observed if item["thread"] == thread and item["generation"] == generation and item["live"]]
    # This fixture records a binding only when exactly one live execution matches
    # trusted thread+generation. It does not assert App Server can expose this fact.
    if len(matches) == 1:
        candidate = matches[0]["turn"]
        if turn is None or turn == candidate:
            connection.execute("UPDATE execution SET turn_id=? WHERE assignment='A'", (candidate,))
            bound = candidate
        else:
            bound = None
    else:
        bound = None
    connection.execute("COMMIT")
    dispatch_count = connection.execute("SELECT count FROM dispatch WHERE operation=?", (operation,)).fetchone()[0]
    current = connection.execute("SELECT state,writer_hold,capacity_hold,turn_id FROM execution WHERE assignment='A'").fetchone()
    connection.close()
    emit(case=case, observed_count=len(observed), match_count=len(matches), bound=bound,
         dispatch_count=dispatch_count, current=current)
    assert bound == expected_binding
    assert dispatch_count == 1 and current[:3] == ("uncertain", 1, 1)


reconcile("before_binding_missing", [], None)
reconcile("before_binding_multiple", [
    {"thread":"thread-A","generation":2,"turn":"turn-1","live":True},
    {"thread":"thread-A","generation":2,"turn":"turn-2","live":True}], None)
reconcile("before_binding_unique", [
    {"thread":"thread-A","generation":2,"turn":"turn-1","live":True}], "turn-1")
db = connect()
db.execute("UPDATE execution SET turn_id='turn-1' WHERE assignment='A'")
db.close()  # Crash after binding; reopen for recovery.
reconcile("after_binding_missing", [], None)
reconcile("after_binding_conflicting", [
    {"thread":"thread-A","generation":2,"turn":"turn-2","live":True}], None)
reconcile("after_binding_same_live", [
    {"thread":"thread-A","generation":2,"turn":"turn-1","live":True}], "turn-1")
db = connect()
db.execute("UPDATE execution SET revision=8 WHERE assignment='A'")
assert db.execute("UPDATE execution SET state='completed' WHERE assignment='A' AND revision=7 AND generation=2").rowcount == 0
assert db.execute("SELECT state,writer_hold,capacity_hold FROM execution WHERE assignment='A'").fetchone() == ("uncertain",1,1)
assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
emit(case="stale_revision", applied=False, dispatch_count=1, holds=(1,1), integrity="ok")
db.close()
trace.close()
