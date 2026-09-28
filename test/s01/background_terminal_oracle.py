"""Separate observer; its PID records are never inputs to runtime cleanup."""

import json
import os
import subprocess
import sys
import threading
import time

base = sys.argv[1]
log = open(os.path.join(base, "oracle.jsonl"), "w")


def command_loop():
    for line in sys.stdin:
        if line.strip() == "release":
            open(os.path.join(base, "release"), "w").close()
        elif line.strip() == "stop":
            return


threading.Thread(target=command_loop, daemon=True).start()
deadline = time.monotonic() + 40
while time.monotonic() < deadline:
    record = {"wall": time.time(), "mono_ns": time.monotonic_ns()}
    for name in ("parent", "child"):
        path = os.path.join(base, name + ".pid")
        if os.path.exists(path):
            pid = int(open(path).read())
            result = subprocess.run(["ps", "-p", str(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "sess=", "-o", "lstart=", "-o", "stat="], capture_output=True, text=True)
            record[name] = result.stdout.strip() or None
    path = os.path.join(base, "effects.log")
    record["effects"] = open(path).read().splitlines() if os.path.exists(path) else []
    log.write(json.dumps(record) + "\n")
    log.flush()
    if os.path.exists(os.path.join(base, "oracle-stop")):
        break
    time.sleep(0.1)
log.close()
