"""One real turn, complete sanitized event inventory, then no-model restart read."""

import hashlib
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid

root = os.path.abspath(sys.argv[1])
work = os.path.join(root, "work")
os.mkdir(root)
os.mkdir(work)
marker = "S01_NATIVE_" + uuid.uuid4().hex[:16].upper()
marker_path = os.path.join(work, "native-marker.txt")
policy = {"type": "workspaceWrite", "writableRoots": [work],
          "networkAccess": False, "excludeSlashTmp": True,
          "excludeTmpdirEnvVar": True}
trace = open(os.path.join(root, "trace.jsonl"), "w")
server = None
events = None
live_items = []
event_methods = {}


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **fields}) + "\n")
    trace.flush()


def safe_text(value):
    if not isinstance(value, str):
        return None
    if marker in value and len(value) <= 600 and all(32 <= ord(c) <= 126 or c in "\n\r\t" for c in value):
        return value
    return {"redacted_length": len(value),
            "sha256": hashlib.sha256(value.encode()).hexdigest()}


def safe_cwd(value):
    if value == work:
        return value
    return safe_text(value) if isinstance(value, str) else None


def summarize_item(item):
    return {"id": item.get("id"), "type": item.get("type"),
            "status": item.get("status"), "command": safe_text(item.get("command")),
            "cwd": safe_cwd(item.get("cwd")), "exitCode": item.get("exitCode"),
            "aggregatedOutput": safe_text(item.get("aggregatedOutput"))}


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


def stop_server():
    global server
    if server is None:
        return
    pid = server.pid
    if server.poll() is None:
        assert os.getpgid(pid) == pid
        os.killpg(pid, signal.SIGKILL)
    server.wait(timeout=5)
    emit(stopped_server_pid=pid, exit=server.returncode)
    server = None


def record(event):
    method = event.get("method")
    if not method:
        # Responses are recorded at their call sites with selected result fields.
        return
    event_methods[method] = event_methods.get(method, 0) + 1
    params = event.get("params", {})
    item = params.get("item", {}) if isinstance(params.get("item"), dict) else {}
    turn = params.get("turn", {}) if isinstance(params.get("turn"), dict) else {}
    summary = {"method": method, "envelope_id": event.get("id"),
               "param_keys": sorted(params) if isinstance(params, dict) else [],
               "threadId": params.get("threadId"), "turnId": params.get("turnId") or turn.get("id"),
               "itemId": params.get("itemId") or item.get("id"),
               "item": summarize_item(item) if item else None,
               "turn_status": turn.get("status")}
    if "delta" in params:
        summary["delta"] = safe_text(params.get("delta"))
    if "deltaBase64" in params:
        summary["deltaBase64_sha256"] = hashlib.sha256(params["deltaBase64"].encode()).hexdigest()
    emit(event=summary)
    if item.get("type") == "commandExecution":
        live_items.append({"method": method, "threadId": summary["threadId"],
                           "turnId": summary["turnId"], **summarize_item(item)})


def send(rid, method, params):
    server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    emit(request=method, id=rid, selected_policy=policy if method == "turn/start" else None)


def receive(predicate, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError("App Server exited")
            continue
        record(event)
        if predicate(event):
            if "error" in event:
                raise RuntimeError(event["error"])
            return event
    raise TimeoutError("protocol response")


def call(rid, method, params, timeout=90):
    send(rid, method, params)
    return receive(lambda e: e.get("id") == rid, timeout)["result"]


def initialize(base):
    call(base, "initialize", {"clientInfo": {"name": "ensemble_s01_native_history",
        "title": "S01 Native History", "version": "0.1.0"}})
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    account = call(base + 1, "account/read", {})
    emit(account_type=(account.get("account") or {}).get("type"))
    assert (account.get("account") or {}).get("type") == "chatgpt"
    config = call(base + 2, "config/read", {"cwd": work, "includeLayers": False})["config"]
    selected = {"approval_policy": config.get("approval_policy"),
                "sandbox_mode": config.get("sandbox_mode")}
    emit(config_selected=selected)
    assert selected == {"approval_policy": "never", "sandbox_mode": "workspace-write"}


def read_history(rid, thread_id, label):
    thread = call(rid, "thread/read", {"threadId": thread_id, "includeTurns": True})["thread"]
    turns = thread.get("turns", [])
    items = [{"turnId": turn.get("id"), **summarize_item(item)}
             for turn in turns for item in turn.get("items", [])]
    emit(history_label=label, thread_id=thread.get("id"), turn_count=len(turns), items=items)
    return items


failure = None
thread_id = None
turn_id = None
before = []
after = []
try:
    emit(fixture_root=root, work=work, marker=marker, policy=policy,
         call_budget=1, rerun_budget=0)
    start_server()
    initialize(1)
    thread = call(4, "thread/start", {"cwd": work, "sandbox": "workspace-write",
        "approvalPolicy": "never", "ephemeral": False})["thread"]
    thread_id = thread["id"]
    emit(thread_id=thread_id, thread_model=thread.get("model"),
         thread_cli_version=thread.get("cliVersion"), thread_cwd=thread.get("cwd"))
    command = "printf '" + marker + "' | tee native-marker.txt"
    prompt = ("Use the foreground shell command tool once to run exactly `" + command +
              "` in this disposable directory. It writes and prints a synthetic marker. "
              "Wait for the command to finish, then report its result. Do not use another tool or path.")
    turn = call(5, "turn/start", {"threadId": thread_id,
        "input": [{"type": "text", "text": prompt}], "cwd": work,
        "sandboxPolicy": policy, "approvalPolicy": "never"})["turn"]
    turn_id = turn["id"]
    emit(turn_id=turn_id, requested_command=command)
    completed = receive(lambda e: e.get("method") == "turn/completed" and
                        e.get("params", {}).get("turn", {}).get("id") == turn_id, 90)
    # Capture already queued trailing envelopes, if any, without another call.
    while True:
        try:
            record(events.get_nowait())
        except queue.Empty:
            break
    emit(turn_completed_status=completed.get("turn", {}).get("status"),
         marker_exists=os.path.exists(marker_path),
         marker_content=open(marker_path).read() if os.path.exists(marker_path) else None,
         event_methods=event_methods, live_command_items=live_items)
    before = read_history(6, thread_id, "before_restart")
    stop_server()
    start_server()
    initialize(10)
    resumed = call(13, "thread/resume", {"threadId": thread_id, "cwd": work,
        "sandbox": "workspace-write", "approvalPolicy": "never"})["thread"]
    emit(resumed_thread_id=resumed.get("id"))
    assert resumed.get("id") == thread_id
    after = read_history(14, thread_id, "after_restart")
    live = [x for x in live_items if x.get("id") and x.get("type") == "commandExecution"
            and x.get("turnId") == turn_id and isinstance(x.get("command"), str)
            and marker in x["command"]]
    stored = [x for x in before if x.get("id") and x.get("type") == "commandExecution"
              and x.get("turnId") == turn_id and isinstance(x.get("command"), str)
              and marker in x["command"]]
    restarted = [x for x in after if x.get("id") and x.get("type") == "commandExecution"
                and x.get("turnId") == turn_id and isinstance(x.get("command"), str)
                and marker in x["command"]]
    correlated = any(a["id"] == b["id"] == c["id"] and
                     a.get("exitCode") == b.get("exitCode") == c.get("exitCode") == 0
                     for a in live for b in stored for c in restarted)
    emit(correlated_native_history=correlated, live_count=len(live),
         stored_count=len(stored), restart_count=len(restarted),
         result="native_history_passed" if correlated else "native_history_unproved")
    if not correlated:
        failure = RuntimeError("native command history did not correlate across restart")
except Exception as error:
    failure = error
    emit(result="probe_error", error=repr(error), thread_id=thread_id, turn_id=turn_id)
finally:
    stop_server()
    trace.close()
if failure:
    raise failure
