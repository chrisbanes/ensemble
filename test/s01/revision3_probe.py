"""Bounded SQLite hold plus real Codex App Server crash/interrupt observations."""

import json
import os
import queue
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time

mode, cwd = sys.argv[1], os.path.abspath(sys.argv[2])
assert mode in {"crash", "stop"}
db_path = os.path.join(cwd, "probe.sqlite")
effects_path = os.path.join(cwd, "effects.log")


def stamp():
    return {"wall": round(time.time(), 6), "mono_ns": time.monotonic_ns()}


def emit(fields):
    print(json.dumps({"at": stamp(), **fields}), flush=True)


def process(pid):
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "stat=", "-o", "comm="],
        text=True, capture_output=True, check=False,
    )
    if result.returncode or not result.stdout.strip():
        return None
    match = re.match(r"\s*(\d+)\s+(.{24})\s+(\S+)\s+(.+)", result.stdout.strip())
    if not match:
        raise RuntimeError(f"unexpected ps output: {result.stdout!r}")
    try:
        pgid, sid = os.getpgid(pid), os.getsid(pid)
    except ProcessLookupError:
        return None
    return {
        "pid": pid, "ppid": int(match.group(1)), "pgid": pgid, "sid": sid,
        "birth_lstart": match.group(2).strip(), "stat": match.group(3),
        "comm": match.group(4).strip(),
    }


def same_process(before):
    after = process(before["pid"])
    return after and after["birth_lstart"] == before["birth_lstart"] and after["comm"] == before["comm"]


db = sqlite3.connect(db_path)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA synchronous=FULL")
db.execute("CREATE TABLE execution (generation TEXT PRIMARY KEY, work_revision INTEGER NOT NULL, state TEXT NOT NULL, writer_hold INTEGER NOT NULL, capacity_hold INTEGER NOT NULL, stop_hold INTEGER NOT NULL, thread_id TEXT, turn_id TEXT)")
generation = f"s01-{mode}-{time.time_ns()}"
db.execute("INSERT INTO execution VALUES (?, 1, 'intent', 1, 1, 0, NULL, NULL)", (generation,))
db.commit()
emit({"sqlite": "intent_committed_before_submission", "generation": generation, "row": db.execute("SELECT * FROM execution").fetchone()})

server = subprocess.Popen(
    ["codex", "app-server", "--stdio"], cwd=cwd, stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
    start_new_session=True,
)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()
owned = []
observed_completed = []


def send(method, rid, params):
    server.stdin.write(json.dumps({"method": method, "id": rid, "params": params}) + "\n")
    server.stdin.flush()
    emit({"send": method, "id": rid})


def receive(predicate, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            event = events.get(timeout=0.25)
        except queue.Empty:
            continue
        if event.get("method") in {"item/started", "item/completed", "turn/completed"}:
            item = event.get("params", {}).get("item", {})
            emit({"event": event["method"], "item_type": item.get("type"), "item_status": item.get("status"), "turn_status": event.get("params", {}).get("turn", {}).get("status")})
        if event.get("method") == "turn/completed":
            observed_completed.append(event)
        if predicate(event):
            if "error" in event:
                raise RuntimeError(event["error"])
            return event
        if server.poll() is not None:
            raise RuntimeError(f"server exited {server.returncode}")
    raise TimeoutError("protocol response")


try:
    emit({"server": process(server.pid)})
    send("initialize", 1, {"clientInfo": {"name": "ensemble_s01_revision3", "title": "Ensemble S01 Revision 3", "version": "0.1.0"}})
    receive(lambda event: event.get("id") == 1)
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send("thread/start", 2, {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True})
    thread_id = receive(lambda event: event.get("id") == 2)["result"]["thread"]["id"]
    send("turn/start", 3, {"threadId": thread_id, "input": [{"type": "text", "text": "Run exactly `python3 escaped_writer.py` in this disposable directory now. It is a bounded termination fixture. Wait for the command to finish and do not inspect or modify other paths."}]})
    turn_id = receive(lambda event: event.get("id") == 3)["result"]["turn"]["id"]
    db.execute("UPDATE execution SET state='bound', thread_id=?, turn_id=? WHERE generation=?", (thread_id, turn_id, generation))
    db.commit()
    emit({"sqlite": "binding_committed", "thread": thread_id, "turn": turn_id})
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if all(os.path.exists(os.path.join(cwd, name)) for name in ("parent.pid", "child.pid", "effects.log")) and os.path.getsize(effects_path) >= 40:
            break
        time.sleep(0.05)
    else:
        raise TimeoutError("escaped writing tool did not start")
    parent = process(int(open(os.path.join(cwd, "parent.pid")).read()))
    child = process(int(open(os.path.join(cwd, "child.pid")).read()))
    if not parent or not child:
        raise RuntimeError("writer disappeared before probe")
    owned = [parent, child]
    before = os.path.getsize(effects_path)
    emit({"writer_parent": parent, "writer_child": child, "effect_bytes_before": before})
    if mode == "stop":
        db.execute("UPDATE execution SET state='stopping', stop_hold=1 WHERE generation=?", (generation,))
        db.commit()
        emit({"sqlite": "stop_hold_committed"})
        send("turn/interrupt", 4, {"threadId": thread_id, "turnId": turn_id})
        response = receive(lambda event: event.get("id") == 4, 15)
        emit({"interrupt_response": response.get("result")})
        completed = observed_completed[-1] if observed_completed else receive(lambda event: event.get("method") == "turn/completed", 15)
        emit({"turn_completed": completed.get("params", {}).get("turn", {}).get("status")})
    else:
        emit({"signal": "SIGKILL", "target_app_server_pgid": os.getpgid(server.pid)})
        os.killpg(server.pid, signal.SIGKILL)
        server.wait(timeout=5)
    time.sleep(1.0)
    after = os.path.getsize(effects_path)
    emit({"server_exit": server.poll(), "writer_parent_after": process(parent["pid"]), "writer_child_after": process(child["pid"]), "effect_bytes_after": after})
    db.close()
    reopened = sqlite3.connect(db_path)
    row = reopened.execute("SELECT generation, work_revision, state, writer_hold, capacity_hold, stop_hold, thread_id, turn_id FROM execution").fetchone()
    replacement_allowed = row[3] == 0 and row[4] == 0 and row[5] == 0
    emit({"sqlite": "reopened", "row": row, "replacement_allowed": replacement_allowed})
    assert not replacement_allowed
    reopened.close()
finally:
    for row in owned:
        if same_process(row):
            os.kill(row["pid"], signal.SIGKILL)
            emit({"cleanup_pid": row["pid"]})
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
        server.wait()
    try:
        db.close()
    except Exception:
        pass
