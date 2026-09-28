import json
import os
import queue
import subprocess
import sys
import threading
import time

cwd = os.path.abspath(sys.argv[1])
proc = subprocess.Popen(
    ["codex", "app-server", "--stdio"],
    cwd=cwd,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
    start_new_session=True,
)
messages = queue.Queue()


def read_stdout():
    for line in proc.stdout:
        try:
            messages.put(json.loads(line))
        except json.JSONDecodeError:
            messages.put({"invalid": line[:200]})


threading.Thread(target=read_stdout, daemon=True).start()


def send(method, request_id=None, params=None):
    payload = {"method": method, "params": params or {}}
    if request_id is not None:
        payload["id"] = request_id
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    print(f"{time.time():.3f} send {method} id={request_id}", flush=True)


def until(predicate, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            msg = messages.get(timeout=min(1, deadline - time.monotonic()))
        except queue.Empty:
            if proc.poll() is not None:
                raise RuntimeError(f"server exited {proc.returncode}")
            continue
        method = msg.get("method")
        if "id" in msg:
            print(f"{time.time():.3f} recv id={msg['id']} result={list(msg.get('result', {}))} error={msg.get('error')}", flush=True)
        elif method in {"turn/started", "turn/completed", "item/completed", "error"}:
            params = msg.get("params", {})
            item = params.get("item", {})
            print(f"{time.time():.3f} event={method} status={params.get('turn', {}).get('status') or item.get('status')} item={item.get('type')} text={item.get('text', '')[:200]} error={params.get('error')}", flush=True)
        if predicate(msg):
            return msg
    raise TimeoutError("waiting for protocol event")


try:
    send("initialize", 1, {"clientInfo": {"name": "ensemble_s01_probe", "title": "Ensemble S01 Probe", "version": "0.1.0"}})
    print("initialize", until(lambda m: m.get("id") == 1, 45), flush=True)
    send("initialized")
    send("account/read", 2, {})
    account = until(lambda m: m.get("id") == 2)
    print("account kind", account.get("result", {}).get("account", {}).get("type"), flush=True)
    send("thread/start", 3, {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never"})
    start = until(lambda m: m.get("id") == 3)
    if "error" in start:
        raise RuntimeError(start["error"])
    thread_id = start["result"]["thread"]["id"]
    print("thread", thread_id, flush=True)
    send("turn/start", 4, {"threadId": thread_id, "input": [{"type": "text", "text": "In this disposable directory, write the exact word S01_OK to proof.txt using a shell command, then report done. Do not inspect or modify anything outside this directory."}]})
    turn = until(lambda m: m.get("id") == 4)
    if "error" in turn:
        raise RuntimeError(turn["error"])
    until(lambda m: m.get("method") == "turn/completed", 120)
    send("thread/read", 5, {"threadId": thread_id, "includeTurns": True})
    history = until(lambda m: m.get("id") == 5)
    if "error" in history:
        raise RuntimeError(history["error"])
    print("history turns", len(history.get("result", {}).get("thread", {}).get("turns", [])), flush=True)
    send("thread/resume", 6, {"threadId": thread_id})
    resumed = until(lambda m: m.get("id") == 6)
    if "error" in resumed:
        raise RuntimeError(resumed["error"])
    print("resume", "result" in resumed, flush=True)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    print("server exit", proc.returncode, flush=True)
