"""Two-turn persistent App Server probe under explicit minimum policy."""

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time

root = os.path.abspath(sys.argv[1])
work = os.path.join(root, "work")
outside = os.path.join(root, "outside")
os.mkdir(root)
os.mkdir(work)
os.mkdir(outside)
trace = open(os.path.join(root, "trace.jsonl"), "w")
policy = {"type": "workspaceWrite", "writableRoots": [work],
          "networkAccess": False, "excludeSlashTmp": True,
          "excludeTmpdirEnvVar": True}
server = None
events = None


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **fields}) + "\n")
    trace.flush()


def start_server():
    global server, events
    events = queue.Queue()
    server = subprocess.Popen(
        ["codex", "app-server", "-c", "approval_policy=never", "-c",
         "sandbox_mode=workspace-write", "--stdio"], cwd=work,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1, start_new_session=True)
    threading.Thread(target=lambda: [events.put(json.loads(x)) for x in server.stdout], daemon=True).start()
    emit(server_pid=server.pid, server_pgid=os.getpgid(server.pid))


def send(rid, method, params):
    server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    emit(request=method, id=rid, policy=policy if method == "turn/start" else None)


def receive(predicate, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError("App Server exited")
            continue
        method = event.get("method")
        if method in ("item/started", "item/completed", "item/commandExecution/outputDelta", "turn/completed"):
            p = event.get("params", {})
            item = p.get("item", {})
            emit(stream_event=method, item_type=item.get("type"),
                 item_id=item.get("id"), command=item.get("command"),
                 exit_code=item.get("exitCode"), status=item.get("status"),
                 output=item.get("aggregatedOutput"),
                 turn_status=p.get("turn", {}).get("status"))
        if predicate(event):
            return event
    raise TimeoutError("protocol response")


def result(event):
    if "error" in event:
        raise RuntimeError(event["error"])
    return event["result"]


def initialize(n):
    send(n, "initialize", {"clientInfo": {"name": "ensemble_s01_minimum_turn",
        "title": "S01 Minimum Turn", "version": "0.1.0"}})
    result(receive(lambda e: e.get("id") == n))
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send(n + 1, "account/read", {})
    account = result(receive(lambda e: e.get("id") == n + 1))
    account_type = (account.get("account") or {}).get("type")
    emit(account_type=account_type)
    assert account_type is not None
    send(n + 2, "config/read", {"cwd": work, "includeLayers": False})
    config = result(receive(lambda e: e.get("id") == n + 2))["config"]
    selected = {"approval_policy": config.get("approval_policy"),
                "sandbox_mode": config.get("sandbox_mode")}
    emit(config_selected=selected)
    assert selected == {"approval_policy": "never", "sandbox_mode": "workspace-write"}


def run_turn(rid, thread_id, prompt):
    send(rid, "turn/start", {"threadId": thread_id,
        "input": [{"type": "text", "text": prompt}],
        "cwd": work, "sandboxPolicy": policy, "approvalPolicy": "never",
        })
    turn_id = result(receive(lambda e: e.get("id") == rid))["turn"]["id"]
    completed = receive(lambda e: e.get("method") == "turn/completed" and
                        e.get("params", {}).get("turn", {}).get("id") == turn_id)
    status = completed["params"]["turn"]["status"]
    emit(turn_id=turn_id, turn_status=status)
    assert status == "completed"
    return turn_id


def read_history(rid, thread_id):
    send(rid, "thread/read", {"threadId": thread_id, "includeTurns": True})
    thread = result(receive(lambda e: e.get("id") == rid))["thread"]
    turns = thread.get("turns", [])
    summaries = []
    for turn in turns:
        for item in turn.get("items", []):
            if item.get("type") == "commandExecution":
                summaries.append({"turn": turn.get("id"), "command": item.get("command"),
                                  "exit": item.get("exitCode"),
                                  "output": item.get("aggregatedOutput")})
    emit(history_turns=len(turns), history_commands=summaries)
    return turns, summaries


def stop_server():
    global server
    if server is not None:
        pid = server.pid
        if server.poll() is None:
            os.killpg(pid, signal.SIGKILL)
        server.wait(timeout=5)
        emit(server_stopped_pid=pid, server_exit=server.returncode)
        server = None


failure = None
try:
    emit(work=work, outside=outside, policy=policy, call_budget=2, rerun_budget=0)
    start_server()
    initialize(1)
    send(4, "thread/start", {"cwd": work,
        "sandbox": "workspace-write", "approvalPolicy": "never",
        "ephemeral": False})
    thread_id = result(receive(lambda e: e.get("id") == 4))["thread"]["id"]
    emit(thread_id=thread_id, thread_policy="workspace-write", approval_policy="never")
    target = os.path.join(outside, "attempt")
    prompt = ("In this disposable S01 fixture, run exactly one shell command: "
              "`printf REAL_INSIDE > inside; printf BAD > " + target + "`. "
              "The second write is intentionally outside the workspace and should be denied. "
              "Report the observed command result briefly. Do not use other tools or paths.")
    first = run_turn(5, thread_id, prompt)
    emit(first_turn=first, inside_exists=os.path.exists(os.path.join(work, "inside")),
         outside_exists=os.path.exists(target))
    assert open(os.path.join(work, "inside")).read() == "REAL_INSIDE"
    assert not os.path.exists(target)
    turns, commands = read_history(6, thread_id)
    assert any("printf REAL_INSIDE" in str(x["command"]) for x in commands)
    stop_server()
    start_server()
    initialize(10)
    send(13, "thread/resume", {"threadId": thread_id, "cwd": work,
        "sandbox": "workspace-write", "approvalPolicy": "never"})
    resumed = result(receive(lambda e: e.get("id") == 13))["thread"]
    emit(resumed_thread=resumed.get("id"))
    assert resumed.get("id") == thread_id
    second = run_turn(14, thread_id,
        "Run exactly `cat inside` in this disposable fixture and report its output. Do not use other tools or paths.")
    turns, commands = read_history(15, thread_id)
    assert len(turns) >= 2
    assert any(x["turn"] == second and "cat inside" in str(x["command"]) for x in commands)
    emit(result="persistent_two_turn_probe_passed")
except Exception as error:
    failure = error
    emit(result="failed", error=repr(error))
finally:
    stop_server()
    trace.close()
if failure:
    raise failure
