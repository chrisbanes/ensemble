"""One bounded real-Codex explicit-Stop diagnostic; run only in a disposable cwd."""

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
for name in ("background_terminal_writer.py", "background_terminal_oracle.py"):
    shutil.copy2(os.path.join(source, name), cwd)
trace = open(os.path.join(cwd, "trace.jsonl"), "w")


def emit(**fields):
    record = {"wall": round(time.time(), 6), "mono_ns": time.monotonic_ns(), **fields}
    trace.write(json.dumps(record) + "\n")
    trace.flush()


def process(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "stat=", "-o", "comm="], capture_output=True, text=True)
    if result.returncode or not result.stdout.strip():
        return None
    match = re.match(r"\s*(\d+)\s+(.{24})\s+(\S+)\s+(.+)", result.stdout.strip())
    if not match:
        raise RuntimeError(result.stdout)
    return {"pid": pid, "ppid": int(match.group(1)), "pgid": os.getpgid(pid), "sid": os.getsid(pid), "birth": match.group(2).strip(), "stat": match.group(3), "comm": match.group(4).strip()}


def same(before):
    after = process(before["pid"])
    return after is not None and (after["birth"], after["comm"]) == (before["birth"], before["comm"])


db = sqlite3.connect(os.path.join(cwd, "probe.sqlite"))
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA synchronous=FULL")
db.execute("CREATE TABLE execution (generation TEXT PRIMARY KEY, state TEXT NOT NULL, writer_hold INTEGER NOT NULL, capacity_hold INTEGER NOT NULL, stop_hold INTEGER NOT NULL, thread_id TEXT, turn_id TEXT)")
generation = str(time.time_ns())
db.execute("INSERT INTO execution VALUES (?, 'intent', 1, 1, 0, NULL, NULL)", (generation,))
db.commit()


def replacement(phase):
    row = db.execute("SELECT state, writer_hold, capacity_hold, stop_hold FROM execution WHERE generation=?", (generation,)).fetchone()
    emit(replacement_phase=phase, row=row, allowed=not any(row[1:]))


replacement("intent_before_submission")
oracle = subprocess.Popen([sys.executable, os.path.join(cwd, "background_terminal_oracle.py"), cwd], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True)
server = subprocess.Popen(["codex", "app-server", "--stdio"], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()
owned = []
completed = []


def send(method, rid, params):
    server.stdin.write(json.dumps({"method": method, "id": rid, "params": params}) + "\n")
    server.stdin.flush()
    emit(send=method, id=rid, params=params if method.startswith("thread/background") else None)


def receive(predicate, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            continue
        if event.get("method") == "turn/completed":
            completed.append(event)
        if event.get("method") in {"item/started", "item/completed", "turn/completed"}:
            emit(notification=event)
        if predicate(event):
            emit(response=event)
            return event
    raise TimeoutError("protocol response")


def require(response):
    if "error" in response:
        raise RuntimeError(response["error"])
    return response["result"]


try:
    emit(predeclared_observation_seconds=3, fixture_natural_completion_seconds=30, server=process(server.pid), oracle=process(oracle.pid))
    send("initialize", 1, {"clientInfo": {"name": "ensemble_s01_bgterminal", "title": "Ensemble S01 Background Terminal", "version": "0.1.0"}, "capabilities": {"experimentalApi": True}})
    require(receive(lambda e: e.get("id") == 1))
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send("thread/start", 2, {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True})
    thread = require(receive(lambda e: e.get("id") == 2))["thread"]["id"]
    send("turn/start", 3, {"threadId": thread, "input": [{"type": "text", "text": "Run exactly `python3 background_terminal_writer.py` in this disposable directory now. Wait for it to finish. Do not inspect or modify other paths."}]})
    turn = require(receive(lambda e: e.get("id") == 3))["turn"]["id"]
    db.execute("UPDATE execution SET state='bound', thread_id=?, turn_id=? WHERE generation=?", (thread, turn, generation))
    db.commit()
    replacement("bound")
    end = time.monotonic() + 45
    while time.monotonic() < end:
        if all(os.path.exists(os.path.join(cwd, n)) for n in ("parent.pid", "child.pid", "effects.log")):
            break
        time.sleep(0.05)
    else:
        raise TimeoutError("real writing tool did not start")
    owned = [process(int(open(os.path.join(cwd, n)).read())) for n in ("parent.pid", "child.pid")]
    if any(p is None for p in owned):
        raise RuntimeError("writer vanished before Stop")
    emit(writer_parent=owned[0], writer_child=owned[1], effects=open(os.path.join(cwd, "effects.log")).read().splitlines())
    db.execute("UPDATE execution SET state='stopping', stop_hold=1 WHERE generation=?", (generation,))
    db.commit()
    replacement("durable_stop_before_interrupt")
    send("turn/interrupt", 4, {"threadId": thread, "turnId": turn})
    require(receive(lambda e: e.get("id") == 4))
    replacement("interrupt_ack")
    if not completed:
        receive(lambda e: e.get("method") == "turn/completed")
    send("thread/backgroundTerminals/list", 5, {"threadId": thread})
    listing = require(receive(lambda e: e.get("id") == 5))
    emit(background_list=listing)
    replacement("before_cleanup")
    send("thread/backgroundTerminals/clean", 6, {"threadId": thread})
    require(receive(lambda e: e.get("id") == 6))
    replacement("cleanup_ack")
    send("thread/backgroundTerminals/list", 7, {"threadId": thread})
    emit(background_list_after=require(receive(lambda e: e.get("id") == 7)))
    oracle.stdin.write("release\n")
    oracle.stdin.flush()
    emit(oracle_release="after_cleanup_ack")
    end = time.monotonic() + 3
    while time.monotonic() < end:
        replacement("observation")
        emit(parent=process(owned[0]["pid"]), child=process(owned[1]["pid"]), effects=open(os.path.join(cwd, "effects.log")).read().splitlines())
        time.sleep(0.25)
    emit(result="writer_survived" if same(owned[0]) or same(owned[1]) or "delayed" in open(os.path.join(cwd, "effects.log")).read() else "no_survivor_observed")
except Exception as error:
    emit(error=repr(error), result="cleanup_unavailable_or_probe_failed")
finally:
    for row in owned:
        if row and same(row):
            os.kill(row["pid"], signal.SIGKILL)
            emit(cleanup_exact_pid=row["pid"])
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
        server.wait(timeout=5)
    emit(server_exit=server.returncode, parent_final=process(owned[0]["pid"]) if owned and owned[0] else None, child_final=process(owned[1]["pid"]) if len(owned) > 1 and owned[1] else None)
    open(os.path.join(cwd, "oracle-stop"), "w").close()
    oracle.wait(timeout=5)
    db.close()
    trace.close()
