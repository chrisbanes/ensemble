"""Successful tool whose detached child retains an open file for a late write."""

import os
import subprocess
import sys
import time

base = os.path.dirname(__file__)
if len(sys.argv) == 1:
    child = subprocess.Popen(
        [sys.executable, __file__, "child"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    with open(os.path.join(base, "parent.pid"), "w") as file:
        file.write(str(os.getpid()))
    with open(os.path.join(base, "child.pid"), "w") as file:
        file.write(str(child.pid))
else:
    with open(os.path.join(base, "effects.log"), "a") as file:
        file.write(f"ready {time.time():.6f}\n")
        file.flush()
        os.fsync(file.fileno())
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if os.path.exists(os.path.join(base, "release")):
                file.write(f"delayed {time.time():.6f}\n")
                file.flush()
                os.fsync(file.fileno())
                break
            time.sleep(0.02)
