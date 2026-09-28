"""Disposable App Server dynamic-tool caller-binding probe."""

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
trace = open(os.path.join(cwd, "trace.jsonl"), "w")
server = subprocess.Popen(["codex", "app-server", "--stdio"], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()
binding = {}
calls = []
failure = None


def emit(**data):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **data}) + "\n")
    trace.flush()


def send(message):
    server.stdin.write(json.dumps(message) + "\n")
    server.stdin.flush()
    emit(send=message)


def wait(predicate, seconds=45):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError(f"App Server exited {server.returncode}")
            continue
        if event.get("method") == "item/tool/call":
            args = event["params"]["arguments"]
            thread_id = event["params"]["threadId"]
            claimed = args.get("assignmentId") if isinstance(args, dict) else None
            accepted = thread_id in binding and claimed == binding[thread_id]
            calls.append({"thread_id": thread_id, "claimed": claimed, "accepted": accepted, "call_id": event["params"]["callId"]})
            emit(callback=event, trusted_binding=binding.get(thread_id), accepted=accepted)
            send({"id": event["id"], "result": {"contentItems": [{"type": "inputText", "text": "accepted" if accepted else "denied"}], "success": accepted}})
        elif event.get("id") is not None or event.get("method") == "turn/completed":
            if event.get("id") == 2:
                emit(account_read_type=(event.get("result", {}).get("account") or {}).get("type"))
            else:
                emit(event=event)
        if predicate(event):
            return event
    raise TimeoutError("protocol event")


def result(event):
    if "error" in event:
        raise RuntimeError(event["error"])
    return event["result"]


try:
    send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "ensemble_s01_identity", "title": "Ensemble S01 Identity", "version": "0.1.0"}, "capabilities": {"experimentalApi": True}}})
    result(wait(lambda e: e.get("id") == 1))
    send({"method": "initialized", "params": {}})
    send({"id": 2, "method": "account/read", "params": {}})
    account = result(wait(lambda e: e.get("id") == 2))
    emit(account_type=(account.get("account") or {}).get("type"))
    tools = [{"type": "function", "name": "record_assignment", "description": "Record an assignment ID in an isolated identity test. Call this tool as instructed.", "inputSchema": {"type": "object", "properties": {"assignmentId": {"type": "string"}}, "required": ["assignmentId"]}}]
    send({"id": 3, "method": "thread/start", "params": {"cwd": cwd, "sandbox": "workspace-write", "approvalPolicy": "never", "ephemeral": True, "dynamicTools": tools}})
    thread_id = result(wait(lambda e: e.get("id") == 3))["thread"]["id"]
    binding[thread_id] = "assignment-A"
    emit(trusted_binding={"thread_id": thread_id, "assignment_id": "assignment-A"})
    for request_id, claimed, expected in ((4, "assignment-B", False), (5, "assignment-A", True)):
        send({"id": request_id, "method": "turn/start", "params": {"threadId": thread_id, "input": [{"type": "text", "text": f"Call the record_assignment tool exactly once with assignmentId '{claimed}'. This is a disposable identity fixture. Do not call shell tools."}]}})
        turn = result(wait(lambda e: e.get("id") == request_id))["turn"]["id"]
        wait(lambda e: e.get("method") == "turn/completed" and e.get("params", {}).get("turn", {}).get("id") == turn)
        matching = [call for call in calls if call["claimed"] == claimed]
        if len(matching) != 1 or matching[0]["accepted"] != expected:
            raise AssertionError(f"identity result for {claimed}: {matching}")
        emit(identity_case=claimed, expected=expected, observed=matching[0])
    emit(result="trusted_binding_rejected_spoof_and_accepted_owner")
except Exception as error:
    failure = error
    emit(result="probe_failed", error=repr(error))
finally:
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
    server.wait(timeout=5)
    emit(server_exit=server.returncode)
    trace.close()
if failure:
    raise failure
