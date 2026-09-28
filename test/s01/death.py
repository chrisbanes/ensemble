import json
import os
import queue
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
proc = subprocess.Popen(
    ["codex", "app-server", "--stdio"], cwd=cwd, stdin=subprocess.PIPE,
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
    start_new_session=True,
)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in proc.stdout], daemon=True).start()


def send(method, request_id, params):
    proc.stdin.write(json.dumps({"method": method, "id": request_id, "params": params}) + "\n")
    proc.stdin.flush()


def response(request_id, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            event = events.get(timeout=1)
        except queue.Empty:
            continue
        if event.get("id") == request_id:
            if "error" in event:
                raise RuntimeError(event["error"])
            return event["result"]
        if event.get("method") == "item/completed":
            item = event.get("params", {}).get("item", {})
            print("item", item.get("type"), item.get("status"), item.get("command"), flush=True)
        if event.get("method") == "turn/completed":
            print("turn completed before kill", event.get("params", {}).get("turn", {}).get("status"), flush=True)
    raise TimeoutError(request_id)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


try:
    print("start", time.time(), "app-server pid", proc.pid, flush=True)
    response_id = 1
    send("initialize", response_id, {"clientInfo": {"name": "ensemble_s01_death", "title": "Ensemble S01 Death", "version": "0.1.0"}})
    response(response_id)
    proc.stdin.write('{"method":"initialized","params":{}}\n')
    proc.stdin.flush()
    send("thread/start", 2, {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True})
    thread_id = response(2)["thread"]["id"]
    print("thread", thread_id, flush=True)
    send("turn/start", 3, {"threadId": thread_id, "input": [{"type": "text", "text": "Run exactly `python3 writer.py` in this directory now. It is a disposable process termination test and writes only in this directory. Wait for the command to finish before replying."}]})
    turn_id = response(3)["turn"]["id"]
    print("turn", turn_id, flush=True)
    effect_path = os.path.join(cwd, "effects.log")
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if os.path.exists(effect_path) and os.path.getsize(effect_path) > 30:
            break
        time.sleep(0.1)
    else:
        raise TimeoutError("writer effect")
    writer_pid = int(open(os.path.join(cwd, "writer.pid")).read())
    child_pid = int(open(os.path.join(cwd, "child.pid")).read())
    before = os.path.getsize(effect_path)
    print("kill", time.time(), "app pgid", os.getpgid(proc.pid), "writer", writer_pid, "child", child_pid, "bytes", before, flush=True)
    os.killpg(proc.pid, signal.SIGKILL)
    proc.wait(timeout=5)
    time.sleep(1.5)
    after = os.path.getsize(effect_path)
    print("after", time.time(), "app exit", proc.returncode, "writer alive", alive(writer_pid), "child alive", alive(child_pid), "bytes", after, flush=True)
finally:
    for filename in ("writer.pid", "child.pid"):
        path = os.path.join(cwd, filename)
        if os.path.exists(path):
            pid = int(open(path).read())
            if alive(pid):
                os.kill(pid, signal.SIGKILL)
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
