"""Capture the real Codex tool tree before killing only this probe's App Server group."""

import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time

cwd = os.path.abspath(sys.argv[1])
for name in ("writer.pid", "child.pid", "effects.log"):
    try:
        os.remove(os.path.join(cwd, name))
    except FileNotFoundError:
        pass


def stamp():
    return {"wall": round(time.time(), 6), "mono_ns": time.monotonic_ns()}


def process(pid):
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "comm="],
        text=True, capture_output=True, check=False,
    )
    if result.returncode or not result.stdout.strip():
        return None
    match = re.match(r"\s*(\d+)\s+(.{24})\s+(.+)", result.stdout.strip())
    if not match:
        raise RuntimeError(f"unexpected ps output: {result.stdout!r}")
    try:
        pgid, sid = os.getpgid(pid), os.getsid(pid)
    except ProcessLookupError:
        return None
    return {
        "pid": pid, "ppid": int(match.group(1)), "pgid": pgid, "sid": sid,
        "birth_lstart": match.group(2).strip(), "comm": match.group(3).strip(),
    }


def lineage(pid):
    seen, rows = set(), []
    while pid > 0 and pid not in seen:
        seen.add(pid)
        row = process(pid)
        if row is None:
            break
        rows.append(row)
        pid = row["ppid"]
    return rows


def same_identity(row):
    current = process(row["pid"])
    return current is not None and current["birth_lstart"] == row["birth_lstart"] and current["comm"] == row["comm"]


server = subprocess.Popen(
    ["codex", "app-server", "--stdio"], cwd=cwd, stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
    start_new_session=True,
)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()
owned = []


def send(method, rid, params):
    server.stdin.write(json.dumps({"method": method, "id": rid, "params": params}) + "\n")
    server.stdin.flush()
    print(json.dumps({"at": stamp(), "send": method, "id": rid}), flush=True)


def response(rid, timeout=45):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            event = events.get(timeout=0.5)
        except queue.Empty:
            continue
        if event.get("id") == rid:
            if "error" in event:
                raise RuntimeError(event["error"])
            return event["result"]
        if event.get("method") in {"item/completed", "turn/completed"}:
            item = event.get("params", {}).get("item", {})
            print(json.dumps({"at": stamp(), "event": event["method"], "item_type": item.get("type"), "item_status": item.get("status")}), flush=True)
    raise TimeoutError(rid)


try:
    print(json.dumps({"at": stamp(), "server": process(server.pid)}), flush=True)
    send("initialize", 1, {"clientInfo": {"name": "ensemble_s01_tree", "title": "Ensemble S01 Tree", "version": "0.1.0"}})
    response(1)
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send("thread/start", 2, {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True})
    thread_id = response(2)["thread"]["id"]
    send("turn/start", 3, {"threadId": thread_id, "input": [{"type": "text", "text": "Run exactly `python3 writer.py` in this disposable directory now. Wait for it to finish. Do not inspect or change anything else."}]})
    turn_id = response(3)["turn"]["id"]
    effect = os.path.join(cwd, "effects.log")
    end = time.monotonic() + 45
    while time.monotonic() < end:
        if all(os.path.exists(os.path.join(cwd, name)) for name in ("writer.pid", "child.pid", "effects.log")) and os.path.getsize(effect) >= 32:
            break
        time.sleep(0.05)
    else:
        raise TimeoutError("writing tool did not start")
    writer_pid = int(open(os.path.join(cwd, "writer.pid")).read())
    child_pid = int(open(os.path.join(cwd, "child.pid")).read())
    writer_tree, child_tree = lineage(writer_pid), lineage(child_pid)
    owned = [writer_tree[0], child_tree[0]]
    before = os.path.getsize(effect)
    print(json.dumps({"at": stamp(), "thread": thread_id, "turn": turn_id, "writer_ancestry": writer_tree, "child_ancestry": child_tree, "bytes_before": before}), flush=True)
    print(json.dumps({"at": stamp(), "signal": "SIGKILL", "target_pgid": os.getpgid(server.pid)}), flush=True)
    os.killpg(server.pid, signal.SIGKILL)
    server.wait(timeout=5)
    time.sleep(1.0)
    print(json.dumps({"at": stamp(), "server_exit": server.returncode, "writer_after": process(writer_pid), "child_after": process(child_pid), "bytes_after": os.path.getsize(effect)}), flush=True)
finally:
    for row in owned:
        if same_identity(row):
            os.kill(row["pid"], signal.SIGKILL)
            print(json.dumps({"at": stamp(), "cleanup_pid": row["pid"]}), flush=True)
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
        server.wait()
