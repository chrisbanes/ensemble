"""Disposable unavailable-login status and App Server account probe."""

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time

cwd = os.path.abspath(sys.argv[1])
os.makedirs(cwd, exist_ok=False)
home = os.path.join(cwd, "home")
os.mkdir(home)
env = os.environ.copy()
env["CODEX_HOME"] = home
for name in ("OPENAI_API_KEY", "CODEX_API_KEY"):
    env.pop(name, None)
trace = open(os.path.join(cwd, "trace.jsonl"), "w")


def emit(**data):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **data}) + "\n")
    trace.flush()


status = subprocess.run(["codex", "login", "status"], cwd=cwd, env=env, capture_output=True, text=True)
emit(command="codex login status", exit=status.returncode, status=status.stdout.strip() or status.stderr.strip())
if status.returncode != 1 or "Not logged in" not in status.stdout + status.stderr:
    raise AssertionError("isolated home did not report unavailable login")

server = subprocess.Popen(["codex", "app-server", "--stdio"], cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()


def ask(rid, method, params):
    server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    end = time.monotonic() + 10
    while time.monotonic() < end:
        event = events.get(timeout=1)
        if event.get("id") == rid:
            return event
    raise TimeoutError(method)


try:
    initialized = ask(1, "initialize", {"clientInfo": {"name": "ensemble_s01_noauth", "title": "Ensemble S01 No Auth", "version": "0.1.0"}})
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    account = ask(2, "account/read", {})
    account_null = account.get("result", {}).get("account") is None
    emit(initialize_ok="result" in initialized, account_null=account_null, account_error=account.get("error"))
    if "result" not in initialized or not account_null:
        raise AssertionError("isolated App Server account was unexpectedly available")
finally:
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
    server.wait(timeout=5)
    emit(server_exit=server.returncode)
    trace.close()
