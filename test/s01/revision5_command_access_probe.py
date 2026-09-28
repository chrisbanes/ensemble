"""Bounded App Server command/exec access probe with disposable paths."""

import base64
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time


cwd = os.path.abspath(sys.argv[1])
outside = cwd + "-outside"
os.makedirs(cwd, exist_ok=False)
os.makedirs(outside, exist_ok=False)
marker = os.path.join(outside, "marker.txt")
with open(marker, "w") as file:
    file.write("SYNTHETIC_OUTSIDE_MARKER")
trace = open(os.path.join(cwd, "trace.jsonl"), "w")
server = subprocess.Popen(
    ["codex", "app-server", "-c", "approval_policy=never", "--stdio"], cwd=cwd,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1, start_new_session=True,
)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()


def emit(**data):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **data}) + "\n")
    trace.flush()


def send(rid, method, params):
    server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    emit(send=method, id=rid, params=params if method == "command/exec" else None)


def receive(rid, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError("App Server exited")
            continue
        if event.get("method") == "command/exec/outputDelta":
            data = event["params"]
            emit(output_delta={
                "processId": data["processId"], "stream": data["stream"],
                "text": base64.b64decode(data["deltaBase64"]).decode("utf-8", "replace"),
                "capReached": data["capReached"],
            })
        if event.get("id") == rid:
            if rid == 5 and "result" in event:
                config = event["result"]["config"]
                emit(response_id=rid, config_approval_policy=config.get("approval_policy"), config_sandbox_mode=config.get("sandbox_mode"))
            else:
                emit(response_id=rid, result=event.get("result"), error=event.get("error"))
            if "error" in event:
                raise RuntimeError(event["error"])
            return event["result"]
    raise TimeoutError("protocol response")


def command(rid, name, argv):
    send(rid, "command/exec", {
        "command": argv, "cwd": cwd,
        "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": [cwd], "networkAccess": False},
        "processId": name, "streamStdoutStderr": True, "timeoutMs": 5000,
    })
    result = receive(rid)
    emit(case=name, exit_code=result["exitCode"])
    return result


failure = None
try:
    emit(server_pid=server.pid, server_pgid=os.getpgid(server.pid), cwd=cwd, outside=outside)
    send(1, "initialize", {"clientInfo": {"name": "ensemble_s01_access_command", "title": "Ensemble S01 Access Command", "version": "0.1.0"}})
    receive(1)
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send(5, "config/read", {"cwd": cwd, "includeLayers": False})
    config = receive(5)["config"]
    emit(effective_approval_policy=config.get("approval_policy"), effective_sandbox_mode=config.get("sandbox_mode"))
    if config.get("approval_policy") != "never":
        raise AssertionError("server did not apply approval_policy=never")
    inside_result = command(2, "inside-write", ["/bin/zsh", "-c", "printf INSIDE_OK > inside.txt; printf 'inside exit=%s\\n' $?"])
    if inside_result["exitCode"] != 0:
        raise AssertionError("inside command failed")
    if open(os.path.join(cwd, "inside.txt")).read() != "INSIDE_OK":
        raise AssertionError("inside write absent")
    target = os.path.join(outside, "attempt.txt")
    write_result = command(3, "outside-write", ["/bin/zsh", "-c", "printf OUTSIDE_ATTEMPT > \"$1\"", "probe", target])
    emit(outside_write_exists=os.path.exists(target))
    if write_result["exitCode"] == 0 or os.path.exists(target):
        raise AssertionError("sibling write was not denied")
    read_result = command(4, "outside-read", ["/bin/cat", marker])
    emit(outside_read_allowed=read_result["exitCode"] == 0)
    emit(result="completed")
except Exception as error:
    failure = error
    emit(result="failed", error=repr(error))
finally:
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
    server.wait(timeout=5)
    emit(server_exit=server.returncode)
    trace.close()
if failure:
    raise failure
