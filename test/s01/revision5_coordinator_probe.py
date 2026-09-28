"""Disposable coordinator SIGKILL during a real Codex writing turn."""

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


def process(pid):
    r = subprocess.run(["ps", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "stat=", "-o", "comm="], capture_output=True, text=True)
    if r.returncode or not r.stdout.strip():
        return None
    m = re.match(r"\s*(\d+)\s+(.{24})\s+(\S+)\s+(.+)", r.stdout.strip())
    if not m:
        raise RuntimeError(r.stdout)
    return {"pid": pid, "ppid": int(m.group(1)), "pgid": os.getpgid(pid), "sid": os.getsid(pid), "birth": m.group(2).strip(), "stat": m.group(3), "comm": m.group(4).strip()}


def same(before):
    after = process(before["pid"])
    return after and (after["birth"], after["comm"]) == (before["birth"], before["comm"])


def child(cwd):
    db = sqlite3.connect(os.path.join(cwd, "probe.sqlite"))
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("CREATE TABLE execution (generation TEXT PRIMARY KEY, state TEXT NOT NULL, writer_hold INTEGER NOT NULL, capacity_hold INTEGER NOT NULL, thread_id TEXT, turn_id TEXT)")
    db.execute("CREATE TABLE pending (operation TEXT PRIMARY KEY, state TEXT NOT NULL)")
    db.execute("INSERT INTO execution VALUES ('original', 'intent', 1, 1, NULL, NULL)")
    db.execute("INSERT INTO pending VALUES ('follow-up', 'queued')")
    db.commit()
    server = subprocess.Popen(["codex", "app-server", "--stdio"], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
    open(os.path.join(cwd, "server.pid"), "w").write(str(server.pid))
    events = queue.Queue()
    threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()
    def ask(rid, method, params):
        server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
        server.stdin.flush()
        end = time.monotonic() + 45
        while time.monotonic() < end:
            event = events.get(timeout=1)
            if event.get("id") == rid:
                if "error" in event:
                    raise RuntimeError(event["error"])
                return event["result"]
        raise TimeoutError(method)
    ask(1, "initialize", {"clientInfo": {"name": "ensemble_s01_r5_crash", "title": "Ensemble S01 R5 Crash", "version": "0.1.0"}})
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    thread = ask(2, "thread/start", {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True})["thread"]["id"]
    turn = ask(3, "turn/start", {"threadId": thread, "input": [{"type": "text", "text": "Run exactly `python3 escaped_writer.py` in this disposable directory. Wait for it to finish. Do not inspect other paths."}]})["turn"]["id"]
    db.execute("UPDATE execution SET state='bound', thread_id=?, turn_id=? WHERE generation='original'", (thread, turn))
    db.commit()
    end = time.monotonic() + 45
    while time.monotonic() < end:
        path = os.path.join(cwd, "effects.log")
        if os.path.exists(path) and os.path.getsize(path) >= 40:
            open(os.path.join(cwd, "coordinator-ready"), "w").close()
            time.sleep(30)
        time.sleep(0.05)
    raise TimeoutError("writer did not start")


def parent(source, cwd):
    os.makedirs(cwd, exist_ok=False)
    shutil.copy2(os.path.join(source, "escaped_writer.py"), cwd)
    subprocess.run(["git", "init", "-q", cwd], check=True)
    trace = open(os.path.join(cwd, "trace.jsonl"), "w")
    def emit(**data):
        trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **data}) + "\n")
        trace.flush()
    coordinator = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--child", cwd], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    owned = []
    server = None
    try:
        end = time.monotonic() + 50
        while time.monotonic() < end and not os.path.exists(os.path.join(cwd, "coordinator-ready")):
            if coordinator.poll() is not None:
                raise RuntimeError(f"coordinator exited {coordinator.returncode}")
            time.sleep(0.05)
        if not os.path.exists(os.path.join(cwd, "coordinator-ready")):
            raise TimeoutError("real tool did not start")
        server = process(int(open(os.path.join(cwd, "server.pid")).read()))
        owned = [process(int(open(os.path.join(cwd, name)).read())) for name in ("parent.pid", "child.pid")]
        coordinator_identity = process(coordinator.pid)
        if not all(owned) or not server or not coordinator_identity:
            raise RuntimeError("process identity missing")
        before = os.path.getsize(os.path.join(cwd, "effects.log"))
        emit(coordinator=coordinator_identity, app_server=server, writer_parent=owned[0], writer_child=owned[1], effect_bytes_before=before)
        os.kill(coordinator.pid, signal.SIGKILL)
        coordinator.wait(timeout=5)
        emit(coordinator_exit=coordinator.returncode)
        time.sleep(1)
        after = os.path.getsize(os.path.join(cwd, "effects.log"))
        db = sqlite3.connect(os.path.join(cwd, "probe.sqlite"))
        row = db.execute("SELECT * FROM execution").fetchone()
        pending = db.execute("SELECT * FROM pending").fetchone()
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        emit(app_server_after=process(server["pid"]), writer_parent_after=process(owned[0]["pid"]), writer_child_after=process(owned[1]["pid"]), effect_bytes_after=after, reopened=row, pending=pending, integrity=integrity)
        assert row[2:4] == (1, 1) and pending == ("follow-up", "queued") and integrity == "ok"
        assert after > before
        emit(result="coordinator_crash_hold_fixture_passed")
        db.close()
    finally:
        if coordinator.poll() is None:
            os.kill(coordinator.pid, signal.SIGKILL)
            coordinator.wait(timeout=5)
        for item in owned:
            if item and same(item):
                os.kill(item["pid"], signal.SIGKILL)
                emit(cleanup_exact_pid=item["pid"])
        if server and same(server):
            os.killpg(server["pgid"], signal.SIGKILL)
            emit(cleanup_app_server_pgid=server["pgid"])
        emit(final_pids={str(item["pid"]): process(item["pid"]) for item in owned if item})
        trace.close()


if sys.argv[1] == "--child":
    child(os.path.abspath(sys.argv[2]))
else:
    parent(os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]))
