"""Disposable SQLite effective-admission and unavailable-service fault fixture."""

import concurrent.futures
import json
import os
import sqlite3
import sys
import threading
import time

cwd = os.path.abspath(sys.argv[1])
os.makedirs(cwd, exist_ok=False)
path = os.path.join(cwd, "admission.sqlite")
trace = open(os.path.join(cwd, "trace.jsonl"), "w")


def emit(**data):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **data}) + "\n")
    trace.flush()


db = sqlite3.connect(path)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA synchronous=FULL")
db.execute("CREATE TABLE gate (case_id TEXT PRIMARY KEY, work_revision INTEGER NOT NULL, ready INTEGER NOT NULL, paused INTEGER NOT NULL, stopped INTEGER NOT NULL, authority INTEGER NOT NULL, dependency_complete INTEGER NOT NULL, initialized INTEGER NOT NULL, admitted_generation TEXT, writer_hold INTEGER NOT NULL, capacity_hold INTEGER NOT NULL)")
db.execute("CREATE TABLE admission (case_id TEXT PRIMARY KEY, operation TEXT UNIQUE NOT NULL, generation TEXT UNIQUE NOT NULL)")
db.commit()


def setup(name, **overrides):
    row = dict(work_revision=1, ready=1, paused=0, stopped=0, authority=1, dependency_complete=1, initialized=1, admitted_generation=None, writer_hold=0, capacity_hold=0)
    row.update(overrides)
    db.execute("INSERT INTO gate VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (name, *row.values()))
    db.commit()


def admit(name, operation, generation, revision=1):
    con = sqlite3.connect(path, timeout=5)
    con.execute("BEGIN IMMEDIATE")
    row = con.execute("SELECT work_revision, ready, paused, stopped, authority, dependency_complete, initialized, admitted_generation, writer_hold, capacity_hold FROM gate WHERE case_id=?", (name,)).fetchone()
    eligible = row == (revision, 1, 0, 0, 1, 1, 1, None, 0, 0)
    if eligible:
        con.execute("UPDATE gate SET admitted_generation=?, writer_hold=1, capacity_hold=1 WHERE case_id=?", (generation, name))
        con.execute("INSERT INTO admission VALUES (?, ?, ?)", (name, operation, generation))
    con.commit()
    after = con.execute("SELECT admitted_generation, writer_hold, capacity_hold FROM gate WHERE case_id=?", (name,)).fetchone()
    con.close()
    emit(case=name, operation=operation, before=row, accepted=eligible, after=after)
    return eligible


negative = {
    "initialization_failed": {"initialized": 0},
    "service_unavailable": {"initialized": 0},
    "pause_before_admission": {"paused": 1},
    "stop_before_admission": {"stopped": 1},
    "authority_revoked": {"authority": 0},
    "dependency_incomplete": {"dependency_complete": 0},
    "not_ready": {"ready": 0},
    "stale_revision": {"work_revision": 2},
}
for name, fields in negative.items():
    setup(name, **fields)
    assert not admit(name, name + "-operation", name + "-generation"), name
    assert db.execute("SELECT count(*) FROM admission WHERE case_id=?", (name,)).fetchone()[0] == 0
emit(negative_cases=list(negative), runtime_submissions=0)

setup("admit_then_stop")
assert admit("admit_then_stop", "active-operation", "active-generation")
db.execute("UPDATE gate SET stopped=1 WHERE case_id='admit_then_stop'")
db.commit()
assert not admit("admit_then_stop", "duplicate-operation", "duplicate-generation")
assert db.execute("SELECT admitted_generation, writer_hold, capacity_hold FROM gate WHERE case_id='admit_then_stop'").fetchone() == ("active-generation", 1, 1)
emit(case="admit_then_stop", state="active_accounted_after_stop")

setup("concurrent")
barrier = threading.Barrier(2)


def contender(i):
    barrier.wait()
    return admit("concurrent", f"racing-operation-{i}", f"racing-generation-{i}")


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(contender, (1, 2)))
assert sorted(results) == [False, True], results
assert db.execute("SELECT count(*) FROM admission WHERE case_id='concurrent'").fetchone()[0] == 1
db.close()
reopened = sqlite3.connect(path)
row = reopened.execute("SELECT admitted_generation, writer_hold, capacity_hold FROM gate WHERE case_id='concurrent'").fetchone()
assert row[0] in ("racing-generation-1", "racing-generation-2") and row[1:] == (1, 1)
assert not admit("concurrent", "post_restart_duplicate", "post_restart_generation")
integrity = reopened.execute("PRAGMA integrity_check").fetchone()[0]
assert integrity == "ok"
emit(case="concurrent", results=results, reopened=row, integrity=integrity, result="effective_admission_fixture_passed")
reopened.close()
trace.close()
