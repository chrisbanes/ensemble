"""Bounded SQLite feasibility check for the approved S01 terminal trust rule."""

import json
import sqlite3
import sys
import threading
import time
from pathlib import Path


root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=False)
db_path = root / "state.sqlite"
trace_path = root / "trace.jsonl"


def record(**fields):
    with trace_path.open("a", encoding="utf-8") as out:
        out.write(json.dumps({"time": time.time(), **fields}, sort_keys=True) + "\n")


def connect():
    db = sqlite3.connect(str(db_path), timeout=5, isolation_level=None)
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("PRAGMA synchronous=FULL")
    return db


with connect() as db:
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        "CREATE TABLE execution (id INTEGER PRIMARY KEY, state TEXT NOT NULL, "
        "bound_thread TEXT NOT NULL, bound_turn TEXT NOT NULL, "
        "reported_thread TEXT, reported_turn TEXT, terminal_status TEXT, "
        "callbacks_active INTEGER NOT NULL, known_unfinished INTEGER NOT NULL, "
        "stop_hold INTEGER NOT NULL, crash_hold INTEGER NOT NULL, "
        "uncertainty_hold INTEGER NOT NULL, writer_hold INTEGER NOT NULL, "
        "capacity_hold INTEGER NOT NULL)"
    )
    db.execute("CREATE TABLE successors (operation TEXT PRIMARY KEY)")
    db.execute(
        "INSERT INTO execution VALUES "
        "(1,'running','thread-A','turn-A','thread-A','turn-A','completed',0,0,0,0,0,1,1)"
    )


def claim(operation):
    db = connect()
    try:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM execution WHERE id=1").fetchone()
        (
            _, state, bound_thread, bound_turn, reported_thread, reported_turn,
            status, callbacks, unfinished, stop, crash, uncertain, writer, capacity,
        ) = row
        eligible = (
            state == "running"
            and reported_thread == bound_thread
            and reported_turn == bound_turn
            and status == "completed"
            and not any((callbacks, unfinished, stop, crash, uncertain))
            and writer == 1
            and capacity == 1
        )
        if eligible:
            db.execute("UPDATE execution SET state='handed_off', writer_hold=0, "
                       "capacity_hold=0 WHERE id=1")
            db.execute("INSERT INTO successors VALUES (?)", (operation,))
        db.execute("COMMIT")
        return eligible
    except BaseException:
        db.execute("ROLLBACK")
        raise
    finally:
        db.close()


def set_case(field, value):
    db = connect()
    db.execute("BEGIN IMMEDIATE")
    db.execute("UPDATE execution SET " + field + "=? WHERE id=1", (value,))
    db.execute("COMMIT")
    db.close()


negative = [
    ("missing_thread", "reported_thread", None),
    ("wrong_thread", "reported_thread", "thread-B"),
    ("missing_turn", "reported_turn", None),
    ("wrong_turn", "reported_turn", "turn-B"),
    ("missing_status", "terminal_status", None),
    ("failed_status", "terminal_status", "failed"),
    ("interrupted_status", "terminal_status", "interrupted"),
    ("active_callback", "callbacks_active", 1),
    ("known_unfinished", "known_unfinished", 1),
    ("stop_hold", "stop_hold", 1),
    ("crash_hold", "crash_hold", 1),
    ("uncertainty_hold", "uncertainty_hold", 1),
]

defaults = {
    "reported_thread": "thread-A", "reported_turn": "turn-A",
    "terminal_status": "completed", "callbacks_active": 0,
    "known_unfinished": 0, "stop_hold": 0, "crash_hold": 0,
    "uncertainty_hold": 0,
}

for name, field, value in negative:
    set_case(field, value)
    assert claim("negative-" + name) is False, name
    with connect() as db:
        state = db.execute("SELECT writer_hold, capacity_hold FROM execution WHERE id=1").fetchone()
        count = db.execute("SELECT count(*) FROM successors").fetchone()[0]
    assert state == (1, 1) and count == 0, name
    record(case=name, rejected=True, writer_capacity_holds=list(state), successors=count)
    set_case(field, defaults[field])

# A late successful terminal report does not clear a pre-existing Stop or crash.
for field in ("stop_hold", "crash_hold"):
    set_case(field, 1)
    set_case("terminal_status", "completed")
    assert claim("late-" + field) is False
    record(case="late_success_after_" + field, rejected=True)
    set_case(field, 0)

barrier = threading.Barrier(2)
results = {}


def contender(name):
    barrier.wait()
    results[name] = claim(name)


threads = [threading.Thread(target=contender, args=(name,)) for name in ("A", "B")]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()

with connect() as db:
    final = db.execute("SELECT state, writer_hold, capacity_hold FROM execution WHERE id=1").fetchone()
    operations = [row[0] for row in db.execute("SELECT operation FROM successors")]
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]

assert sorted(results.values()) == [False, True], results
assert final == ("handed_off", 0, 0), final
assert len(operations) == 1 and integrity == "ok"
record(case="eligible_success", results=results, successor_operation=operations[0],
       final=list(final), integrity=integrity)
