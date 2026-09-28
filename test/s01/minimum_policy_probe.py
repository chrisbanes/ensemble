"""Bounded disposable command/exec policy probe; no model call or config dump."""

import base64
import json
import os
import queue
import signal
import socket
import subprocess
import sys
import threading
import time

root = os.path.abspath(sys.argv[1])
work = os.path.join(root, "work")
outside = os.path.join(root, "outside")
temp = os.path.join(root, "temp")
for path in (root, work, outside, temp):
    os.mkdir(path)
with open(os.path.join(outside, "marker"), "w") as f:
    f.write("S01_SYNTHETIC_OUTSIDE")
os.symlink(outside, os.path.join(work, "escape"))
trace = open(os.path.join(root, "trace.jsonl"), "w")
events = queue.Queue()
server = subprocess.Popen(
    ["codex", "app-server", "-c", "approval_policy=never", "-c",
     "sandbox_mode=workspace-write", "--stdio"], cwd=work,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, bufsize=1, start_new_session=True,
)
threading.Thread(target=lambda: [events.put(json.loads(x)) for x in server.stdout], daemon=True).start()
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(1)
listener.settimeout(0.1)
accepted = []
stop = threading.Event()


def accept_loop():
    while not stop.is_set():
        try:
            conn, _ = listener.accept()
            accepted.append(time.time())
            conn.close()
        except socket.timeout:
            pass
        except OSError:
            break


threading.Thread(target=accept_loop, daemon=True).start()


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **fields}) + "\n")
    trace.flush()


def send(rid, method, params):
    server.stdin.write(json.dumps({"id": rid, "method": method, "params": params}) + "\n")
    server.stdin.flush()
    emit(request=method, id=rid, case=params.get("processId"))


def receive(rid):
    deadline = time.monotonic() + 15
    output = []
    while time.monotonic() < deadline:
        try:
            event = events.get(timeout=0.1)
        except queue.Empty:
            if server.poll() is not None:
                raise RuntimeError("App Server exited")
            continue
        if event.get("method") == "command/exec/outputDelta":
            p = event["params"]
            chunk = base64.b64decode(p["deltaBase64"]).decode("utf-8", "replace")
            output.append((p["stream"], chunk))
        if event.get("id") == rid:
            if "error" in event:
                raise RuntimeError(event["error"])
            return event["result"], output
    raise TimeoutError("command response")


policy = {"type": "workspaceWrite", "writableRoots": [work],
          "networkAccess": False, "excludeSlashTmp": True,
          "excludeTmpdirEnvVar": True}


def command(rid, name, args, env=None):
    send(rid, "command/exec", {"command": args, "cwd": work,
        "sandboxPolicy": policy, "processId": name,
        "streamStdoutStderr": True, "timeoutMs": 5000,
        "env": env or {}})
    result, output = receive(rid)
    emit(case=name, exit=result["exitCode"], output=output)
    return result["exitCode"]


failure = None
try:
    emit(server_pid=server.pid, server_pgid=os.getpgid(server.pid),
         work=work, outside=outside, temp=temp, policy=policy,
         listener_port=listener.getsockname()[1])
    send(1, "initialize", {"clientInfo": {"name": "ensemble_s01_minimum_policy",
        "title": "S01 Minimum Policy", "version": "0.1.0"}})
    receive(1)
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send(2, "config/read", {"cwd": work, "includeLayers": False})
    config = receive(2)[0]["config"]
    selected = {"approval_policy": config.get("approval_policy"),
                "sandbox_mode": config.get("sandbox_mode")}
    emit(config_selected=selected)
    assert selected == {"approval_policy": "never", "sandbox_mode": "workspace-write"}
    with socket.create_connection(("127.0.0.1", listener.getsockname()[1]), timeout=1):
        pass
    deadline = time.monotonic() + 1
    while len(accepted) < 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert len(accepted) == 1
    emit(host_loopback_control=1)
    cases = [
        ("inside", ["/bin/sh", "-c", "printf INSIDE > inside"], True, None),
        ("sibling", ["/bin/sh", "-c", "printf BAD > \"$1\"", "sh", os.path.join(outside, "write")], False, None),
        ("symlink", ["/bin/sh", "-c", "printf BAD > escape/write"], False, None),
        ("temp", ["/bin/sh", "-c", "printf BAD > \"$TMPDIR/write\""], False, {"TMPDIR": temp}),
        ("slash_tmp", ["/bin/sh", "-c", "printf BAD > \"$1\"", "sh", os.path.join("/tmp", os.path.basename(root) + "-write")], False, None),
        ("outside_read", ["/bin/cat", os.path.join(outside, "marker")], True, None),
        ("network", ["/usr/bin/curl", "--max-time", "2", "--silent", "--show-error", "http://127.0.0.1:%d/" % listener.getsockname()[1]], False, None),
    ]
    for i, (name, argv, should_succeed, env) in enumerate(cases, 3):
        exit_code = command(i, name, argv, env)
        if (exit_code == 0) != should_succeed:
            emit(result="control_failed", failed_case=name)
            raise AssertionError("policy case %s exit=%s" % (name, exit_code))
    effects = {"inside": os.path.exists(os.path.join(work, "inside")),
               "sibling": os.path.exists(os.path.join(outside, "write")),
               "symlink": os.path.exists(os.path.join(outside, "write")),
               "temp": os.path.exists(os.path.join(temp, "write")),
               "slash_tmp": os.path.exists(os.path.join("/tmp", os.path.basename(root) + "-write")),
               "network_accepted_after_control": len(accepted) > 1}
    emit(effects=effects)
    assert effects == {"inside": True, "sibling": False, "symlink": False,
                       "temp": False, "slash_tmp": False, "network_accepted_after_control": False}
    emit(result="selected_command_controls_passed")
except Exception as error:
    failure = error
    emit(result="failed", error=repr(error))
finally:
    stop.set()
    listener.close()
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGKILL)
    server.wait(timeout=5)
    emit(server_exit=server.returncode)
    trace.close()
if failure:
    raise failure
