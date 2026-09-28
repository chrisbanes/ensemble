"""Read/resume only the disposable S01 thread after App Server restart."""

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time

root = os.path.abspath(sys.argv[1])
thread_id = sys.argv[2]
work = os.path.join(root, "work")
trace = open(os.path.join(root, "restart-trace.jsonl"), "w")
p = subprocess.Popen(["codex", "app-server", "-c", "approval_policy=never",
                      "-c", "sandbox_mode=workspace-write", "--stdio"],
                     cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, start_new_session=True)
q = queue.Queue()
threading.Thread(target=lambda: [q.put(json.loads(x)) for x in p.stdout], daemon=True).start()


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **fields}) + "\n")
    trace.flush()


def call(rid, method, params):
    p.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    p.stdin.flush()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        event = q.get(timeout=1)
        if event.get("id") == rid:
            if "error" in event:
                raise RuntimeError(event["error"])
            return event["result"]
    raise TimeoutError(method)


failure = None
try:
    emit(server_pid=p.pid, server_pgid=os.getpgid(p.pid), thread_id=thread_id)
    call(1, "initialize", {"clientInfo": {"name":"s01_restart_read",
        "title":"S01 Restart Read", "version":"0.1"}})
    p.stdin.write('{"method":"initialized","params":{}}\n')
    p.stdin.flush()
    account = call(2, "account/read", {})
    emit(account_type=(account.get("account") or {}).get("type"))
    assert (account.get("account") or {}).get("type") == "chatgpt"
    config = call(3, "config/read", {"cwd": work, "includeLayers": False})["config"]
    selected = (config.get("approval_policy"), config.get("sandbox_mode"))
    emit(config_selected=selected)
    assert selected == ("never", "workspace-write")
    resumed = call(4, "thread/resume", {"threadId":thread_id,
        "cwd":work, "sandbox":"workspace-write", "approvalPolicy":"never"})["thread"]
    assert resumed["id"] == thread_id
    emit(resumed_thread=resumed["id"], response_keys=sorted(resumed.keys()))
    history = call(5, "thread/read", {"threadId":thread_id, "includeTurns":True})["thread"]
    turns = history.get("turns", [])
    types = [[item.get("type") for item in turn.get("items", [])] for turn in turns]
    emit(stored_turn_count=len(turns), stored_item_types=types)
    assert len(turns) == 1
    emit(result="restart_read_resume_passed_without_model_call")
except Exception as error:
    failure = error
    emit(result="failed", error=repr(error))
finally:
    if p.poll() is None:
        os.killpg(p.pid, signal.SIGKILL)
    p.wait(timeout=5)
    emit(server_exit=p.returncode)
    trace.close()
if failure:
    raise failure
