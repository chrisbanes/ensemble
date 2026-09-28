"""Bounded real-Codex cooperative handoff and negative-hold fixture."""

import concurrent.futures
import json
import os
import queue
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time

source, cwd = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
os.makedirs(cwd, exist_ok=False)
for name in ("revision5_cooperative_writer.py", "background_terminal_oracle.py"):
    shutil.copy2(os.path.join(source, name), cwd)
trace = open(os.path.join(cwd, "trace.jsonl"), "w")
db_path = os.path.join(cwd, "probe.sqlite")


def emit(**data):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **data}) + "\n")
    trace.flush()


def proc(pid):
    r = subprocess.run(["ps", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "stat=", "-o", "comm="], capture_output=True, text=True)
    if r.returncode or not r.stdout.strip():
        return None
    m = re.match(r"\s*(\d+)\s+(.{24})\s+(\S+)\s+(.+)", r.stdout.strip())
    if not m:
        raise RuntimeError(r.stdout)
    return {"pid": pid, "ppid": int(m.group(1)), "pgid": os.getpgid(pid), "sid": os.getsid(pid), "birth": m.group(2).strip(), "stat": m.group(3), "comm": m.group(4).strip()}


def same(before):
    after = proc(before["pid"])
    return after and (after["birth"], after["comm"]) == (before["birth"], before["comm"])


db = sqlite3.connect(db_path)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA synchronous=FULL")
db.execute("CREATE TABLE execution (generation TEXT PRIMARY KEY, state TEXT NOT NULL, final INTEGER NOT NULL, status TEXT NOT NULL, tools_ended INTEGER NOT NULL, observations_complete INTEGER NOT NULL, known_survivor INTEGER NOT NULL, stop_hold INTEGER NOT NULL, writer_hold INTEGER NOT NULL, capacity_hold INTEGER NOT NULL)")
db.execute("CREATE TABLE admission (operation TEXT PRIMARY KEY, generation TEXT UNIQUE NOT NULL)")
db.commit()


def claim(generation, operation):
    con = sqlite3.connect(db_path, timeout=5)
    con.execute("BEGIN IMMEDIATE")
    row = con.execute("SELECT state, final, status, tools_ended, observations_complete, known_survivor, stop_hold, writer_hold, capacity_hold FROM execution WHERE generation=?", (generation,)).fetchone()
    eligible = row == ("normal_complete", 1, "completed", 1, 1, 0, 0, 1, 1)
    if eligible:
        con.execute("UPDATE execution SET state='handed_off', writer_hold=0, capacity_hold=0 WHERE generation=?", (generation,))
        inserted = con.execute("INSERT OR IGNORE INTO admission VALUES (?, ?)", (operation, generation + "-successor")).rowcount
        assert inserted == 1
    con.commit()
    count = con.execute("SELECT count(*) FROM admission WHERE operation=?", (operation,)).fetchone()[0]
    after = con.execute("SELECT state, writer_hold, capacity_hold FROM execution WHERE generation=?", (generation,)).fetchone()
    con.close()
    emit(claim_generation=generation, operation=operation, before=row, admitted=eligible, admission_count=count, after=after)
    return eligible


negative = {
    "crash": ("uncertain", 1, "completed", 1, 1, 0, 0),
    "stop": ("normal_complete", 1, "completed", 1, 1, 0, 1),
    "failed": ("normal_complete", 1, "failed", 1, 1, 0, 0),
    "interrupted": ("normal_complete", 1, "interrupted", 1, 1, 0, 0),
    "missing_observation": ("normal_complete", 1, "completed", 1, 0, 0, 0),
    "known_survivor": ("normal_complete", 1, "completed", 1, 1, 1, 0),
    "active_registered_tool": ("normal_complete", 1, "completed", 0, 1, 0, 0),
    "not_final": ("normal_complete", 0, "completed", 1, 1, 0, 0),
    "deadline_expired": ("uncertain", 1, "completed", 1, 1, 0, 0),
}
for name, fields in negative.items():
    db.execute("INSERT INTO execution VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)", (name, *fields))
    db.commit()
    assert not claim(name, "replacement-" + name), name
    assert db.execute("SELECT writer_hold, capacity_hold FROM execution WHERE generation=?", (name,)).fetchone() == (1, 1)
emit(negative_cases=list(negative), result="negative_holds_passed")

generation = "normal-" + str(time.time_ns())
db.execute("INSERT INTO execution VALUES (?, 'intent', 1, 'inProgress', 0, 0, 0, 0, 1, 1)", (generation,))
db.execute("INSERT INTO admission VALUES ('original-operation', ?)", (generation,))
db.commit()
oracle = subprocess.Popen([sys.executable, os.path.join(cwd, "background_terminal_oracle.py"), cwd], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
server = subprocess.Popen(["codex", "app-server", "--stdio"], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()
active_tools = set()
completed_tools = []
child_identity = None
failure = None


def send(rid, method, params):
    server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    emit(send=method, request_id=rid)


def receive(predicate, timeout=45):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError("App Server exited")
            continue
        method = event.get("method")
        item = event.get("params", {}).get("item", {})
        if item.get("type") in ("commandExecution", "dynamicToolCall"):
            if method == "item/started":
                active_tools.add(item["id"])
            elif method == "item/completed":
                active_tools.discard(item["id"])
                completed_tools.append(item)
        if method in ("item/started", "item/completed", "turn/completed") or "id" in event:
            emit(event=event)
        if predicate(event):
            return event
    raise TimeoutError("protocol event")


def require(event):
    if "error" in event:
        raise RuntimeError(event["error"])
    return event["result"]


try:
    emit(predeclared_observation_seconds=2, child_natural_timeout_seconds=30, app_server=proc(server.pid), oracle=proc(oracle.pid))
    send(1, "initialize", {"clientInfo": {"name": "ensemble_s01_r5", "title": "Ensemble S01 R5", "version": "0.1.0"}, "capabilities": {"experimentalApi": True}})
    require(receive(lambda e: e.get("id") == 1))
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send(2, "thread/start", {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True})
    thread_id = require(receive(lambda e: e.get("id") == 2))["thread"]["id"]
    send(3, "turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "Run exactly `python3 revision5_cooperative_writer.py` in this disposable directory, wait for that command to finish, then say done. Do not inspect other files or paths."}]})
    turn_id = require(receive(lambda e: e.get("id") == 3))["turn"]["id"]
    completed = receive(lambda e: e.get("method") == "turn/completed" and e.get("params", {}).get("turn", {}).get("id") == turn_id)
    status = completed["params"]["turn"]["status"]
    send(4, "thread/backgroundTerminals/list", {"threadId": thread_id})
    terminals = require(receive(lambda e: e.get("id") == 4))
    commands = [item for item in completed_tools if item.get("type") == "commandExecution"]
    emit(normal_completion={"thread_id": thread_id, "turn_id": turn_id, "status": status, "active_registered_tools": list(active_tools), "completed_commands": commands, "background_terminals": terminals})
    if status != "completed" or active_tools or not commands or any(item.get("exitCode") != 0 for item in commands) or terminals.get("data"):
        raise AssertionError("normal-success predicate unavailable")
    db.execute("UPDATE execution SET state='normal_complete', status='completed', tools_ended=1, observations_complete=1 WHERE generation=?", (generation,))
    db.commit()
    barrier = threading.Barrier(2)
    def contender(index):
        barrier.wait()
        return claim(generation, "successor-operation")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        admitted = list(pool.map(contender, (1, 2)))
    if sorted(admitted) != [False, True]:
        raise AssertionError(f"successor race: {admitted}")
    emit(successor_claims=admitted, successor_count=db.execute("SELECT count(*) FROM admission WHERE operation='successor-operation'").fetchone()[0])
    send(5, "thread/start", {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True})
    successor_thread = require(receive(lambda e: e.get("id") == 5))["thread"]["id"]
    send(6, "turn/start", {"threadId": successor_thread, "input": [{"type": "text", "text": "Write the word SUCCESSOR to successor.log using one shell command in this disposable directory. Do not inspect other paths."}]})
    successor_turn = require(receive(lambda e: e.get("id") == 6))["turn"]["id"]
    successor_completed = receive(lambda e: e.get("method") == "turn/completed" and e.get("params", {}).get("turn", {}).get("id") == successor_turn)
    if successor_completed["params"]["turn"]["status"] != "completed" or not os.path.exists(os.path.join(cwd, "successor.log")):
        raise AssertionError("successor did not complete its write")
    emit(successor_effect=open(os.path.join(cwd, "successor.log")).read())
    oracle.stdin.write("release\n")
    oracle.stdin.flush()
    emit(oracle_release="after_successor_write")
    end = time.monotonic() + 2
    while time.monotonic() < end:
        effects = open(os.path.join(cwd, "effects.log")).read().splitlines() if os.path.exists(os.path.join(cwd, "effects.log")) else []
        emit(effects=effects, original_holds=db.execute("SELECT writer_hold, capacity_hold FROM execution WHERE generation=?", (generation,)).fetchone())
        time.sleep(0.1)
    if "delayed" not in open(os.path.join(cwd, "effects.log")).read():
        raise AssertionError("detached late write not observed")
    emit(result="cooperative_handoff_with_overlapping_write_observed")
except Exception as error:
    failure = error
    emit(result="probe_failed", error=repr(error))
finally:
    # Oracle PID records are read only after all candidate release decisions.
    path = os.path.join(cwd, "child.pid")
    if os.path.exists(path):
        child_identity = proc(int(open(path).read()))
        if child_identity and same(child_identity):
            os.kill(child_identity["pid"], signal.SIGKILL)
            emit(cleanup_exact_child=child_identity)
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
    server.wait(timeout=5)
    open(os.path.join(cwd, "oracle-stop"), "w").close()
    oracle.wait(timeout=5)
    emit(server_exit=server.returncode, child_final=proc(child_identity["pid"]) if child_identity else None)
    db.close()
    trace.close()
if failure:
    raise failure
