import os
import subprocess
import sys
import time

base = os.path.dirname(__file__)
if len(sys.argv) == 1:
    child = subprocess.Popen([sys.executable, __file__, "child"])
    with open(os.path.join(base, "writer.pid"), "w") as file:
        file.write(str(os.getpid()))
    with open(os.path.join(base, "child.pid"), "w") as file:
        file.write(str(child.pid))
    child.wait()
else:
    with open(os.path.join(base, "effects.log"), "a") as file:
        for index in range(120):
            file.write(f"{time.time():.3f} {index}\n")
            file.flush()
            os.fsync(file.fileno())
            time.sleep(0.25)
