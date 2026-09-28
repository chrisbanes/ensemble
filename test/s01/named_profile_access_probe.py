"""Bounded, no-model S01 named-profile boundary probe."""

import base64
import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time


workspace = os.path.abspath(sys.argv[1])
sibling = workspace + "-sibling"
home_like = workspace + "-home-like"
for path in (workspace, sibling, home_like):
    os.makedirs(path, exist_ok=False)
for path, marker in ((sibling, "SYNTHETIC_SIBLING_SECRET"), (home_like, "SYNTHETIC_HOME_SECRET")):
    with open(os.path.join(path, "marker.txt"), "w") as file:
        file.write(marker)
os.symlink(sibling, os.path.join(workspace, "outside-link"))
trace = open(os.path.join(workspace, "trace.jsonl"), "w")
profile = "s01_probe"
config_overrides = [
    "approval_policy=never",
    'permissions.s01_probe.extends=":workspace"',
    'permissions.s01_probe.filesystem.":root"="deny"',
    'permissions.s01_probe.filesystem.":minimal"="read"',
    'permissions.s01_probe.filesystem.":tmpdir"="deny"',
    'permissions.s01_probe.filesystem.":slash_tmp"="deny"',
    "permissions.s01_probe.network.enabled=false",
]
argv = ["codex", "app-server"]
for override in config_overrides:
    argv.extend(["-c", override])
argv.append("--stdio")
server = subprocess.Popen(
    argv, cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True,
)
events = queue.Queue()
threading.Thread(target=lambda: [events.put(json.loads(line)) for line in server.stdout], daemon=True).start()


def emit(**fields):
    trace.write(json.dumps({"wall": time.time(), "mono_ns": time.monotonic_ns(), **fields}) + "\n")
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
            if rid == 2 and "result" in event:
                cfg = event["result"]["config"]
                emit(response_id=rid, approval_policy=cfg.get("approval_policy"),
                     sandbox_mode=cfg.get("sandbox_mode"),
                     profile_configured=profile in (cfg.get("permissions") or {}))
            elif rid == 3 and "result" in event:
                emit(response_id=rid, profiles=[{"id": p["id"], "allowed": p["allowed"]}
                                                    for p in event["result"]["data"]])
            elif rid == 4 and "result" in event:
                emit(response_id=rid, account_type=(event["result"].get("account") or {}).get("type"))
            else:
                emit(response_id=rid, result=event.get("result"), error=event.get("error"))
            if "error" in event:
                raise RuntimeError(event["error"])
            return event["result"]
    raise TimeoutError("protocol response")


def command(rid, label, argv):
    send(rid, "command/exec", {
        "command": argv, "cwd": workspace, "permissionProfile": profile,
        "processId": label, "streamStdoutStderr": True, "timeoutMs": 5000,
    })
    result = receive(rid)
    emit(case=label, exit_code=result["exitCode"])
    return result["exitCode"]


failure = None
try:
    emit(server_pid=server.pid, server_pgid=os.getpgid(server.pid),
         workspace=workspace, sibling=sibling, home_like=home_like,
         server_argv=argv)
    send(1, "initialize", {"clientInfo": {"name": "ensemble_s01_named_profile", "title": "Ensemble S01 Named Profile", "version": "0.1.0"}})
    receive(1)
    server.stdin.write('{"method":"initialized","params":{}}\n')
    server.stdin.flush()
    send(2, "config/read", {"cwd": workspace, "includeLayers": False})
    cfg = receive(2)["config"]
    if cfg.get("approval_policy") != "never" or profile not in (cfg.get("permissions") or {}):
        raise AssertionError("probe-local never/profile configuration missing")
    send(3, "permissionProfile/list", {"cwd": workspace})
    profiles = receive(3)["data"]
    if not any(p["id"] == profile and p["allowed"] for p in profiles):
        raise AssertionError("named profile absent or disallowed")
    send(4, "account/read", {})
    account_type = (receive(4).get("account") or {}).get("type")
    if not account_type:
        raise AssertionError("existing login unavailable")
    emit(login_available=True)
    cases = [
        ("inside-control", ["/bin/zsh", "-c", "printf INSIDE_OK > inside.txt; cat inside.txt"], 0),
        ("sibling-read", ["/bin/cat", os.path.join(sibling, "marker.txt")], 1),
        ("sibling-write", ["/bin/zsh", "-c", "printf X > \"$1\"", "probe", os.path.join(sibling, "attempt.txt")], 1),
        ("home-read", ["/bin/cat", os.path.join(home_like, "marker.txt")], 1),
        ("home-write", ["/bin/zsh", "-c", "printf X > \"$1\"", "probe", os.path.join(home_like, "attempt.txt")], 1),
        ("symlink-read", ["/bin/cat", os.path.join(workspace, "outside-link", "marker.txt")], 1),
        ("symlink-write", ["/bin/zsh", "-c", "printf X > outside-link/attempt.txt"], 1),
        ("toolchain", ["/usr/bin/python3", "-c", "import sqlite3; print(sqlite3.sqlite_version)"], 0),
    ]
    for rid, (label, cmd, expected) in enumerate(cases, 10):
        actual = command(rid, label, cmd)
        if actual != expected:
            raise AssertionError("%s exit %s, expected %s" % (label, actual, expected))
    if open(os.path.join(workspace, "inside.txt")).read() != "INSIDE_OK":
        raise AssertionError("inside control effect missing")
    for path in (sibling, home_like):
        if os.path.exists(os.path.join(path, "attempt.txt")):
            raise AssertionError("outside write effect found")
    emit(result="direct_profile_cases_passed")
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
