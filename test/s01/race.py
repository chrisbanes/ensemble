"""Independent oracle versus an ancestry/group scanner after an escaped double fork."""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time


def stamp():
    return {"wall": round(time.time(), 6), "mono_ns": time.monotonic_ns()}


def process(pid):
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "ppid=", "-o", "lstart=", "-o", "stat=", "-o", "comm="],
        text=True, capture_output=True, check=False,
    )
    if result.returncode or not result.stdout.strip():
        return None
    match = re.match(r"\s*(\d+)\s+(.{24})\s+(\S+)\s+(.+)", result.stdout.strip())
    if not match:
        raise RuntimeError(f"unexpected ps output: {result.stdout!r}")
    try:
        pgid, sid = os.getpgid(pid), os.getsid(pid)
    except ProcessLookupError:
        return None
    return {
        "pid": pid, "ppid": int(match.group(1)), "pgid": pgid, "sid": sid,
        "birth_lstart": match.group(2).strip(), "stat": match.group(3),
        "comm": match.group(4).strip(),
    }


def emit(fields):
    print(json.dumps({"at": stamp(), **fields}), flush=True)


def coordinator(fd, effect):
    channel = socket.socket(fileno=fd)
    channel.sendall((json.dumps({"ready": os.getpid()}) + "\n").encode())
    if channel.recv(20) != b"GO":
        os._exit(2)
    intermediate = os.fork()
    if intermediate:
        os._exit(0)
    os.setsid()  # Leave the coordinator's group and session.
    writer = os.fork()
    if writer:
        os._exit(0)  # Reparent the writer before any scanner is allowed to run.
    with open(effect, "a") as file:
        channel.sendall((json.dumps({"pid": os.getpid(), "open": stamp()}) + "\n").encode())
        command = channel.recv(20)
        if command != b"WRITE":
            os._exit(2)
        file.write(f"{time.time():.6f} delayed-writer\n")
        file.flush()
        os.fsync(file.fileno())
        channel.sendall((json.dumps({"wrote": stamp()}) + "\n").encode())
        channel.recv(20)  # Oracle owns cleanup; scanner never receives this channel.
    os._exit(0)


def scanner(root_pid, root_pgid):
    # This process receives only coordinator identity, never oracle writer records.
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid="], text=True, capture_output=True, check=True,
    )
    rows = [tuple(map(int, line.split())) for line in result.stdout.splitlines() if len(line.split()) == 3]
    known = {root_pid}
    while True:
        found = {pid for pid, ppid, _ in rows if ppid in known and pid not in known}
        if not found:
            break
        known.update(found)
    visible = sorted(pid for pid, _, pgid in rows if pid in known or pgid == root_pgid)
    emit({"scanner_root": root_pid, "scanner_group": root_pgid, "visible": visible, "row_count": len(rows)})


def oracle(effect):
    try:
        os.remove(effect)
    except FileNotFoundError:
        pass
    parent, child = socket.socketpair()
    spawned = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "coordinator", str(child.fileno()), effect],
        pass_fds=[child.fileno()], start_new_session=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    child.close()
    parent.settimeout(5)
    stream = parent.makefile("r")
    ready = json.loads(stream.readline())
    assert ready["ready"] == spawned.pid
    root = process(spawned.pid)
    if root is None:
        raise RuntimeError("coordinator exited before root identity capture")
    emit({"coordinator": root})
    writer = None
    try:
        parent.sendall(b"GO")
        hello = json.loads(stream.readline())
        writer_pid = hello["pid"]
        spawned.wait(timeout=5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            writer = process(writer_pid)
            if writer and writer["ppid"] == 1:
                break
            time.sleep(0.02)
        else:
            raise TimeoutError("writer did not reparent")
        emit({"oracle_writer": writer, "coordinator_exit": spawned.returncode, "effect_bytes_before": os.path.getsize(effect)})
        scan = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "scanner", str(root["pid"]), str(root["pgid"])],
            text=True, capture_output=True, check=True,
        )
        scan_line = json.loads(scan.stdout)
        emit({"scanner_observation": scan_line, "oracle_knows_writer": writer_pid})
        assert writer_pid not in scan_line["visible"]
        assert os.path.getsize(effect) == 0
        parent.sendall(b"WRITE")
        wrote = json.loads(stream.readline())
        assert os.path.getsize(effect) > 0
        emit({"oracle_received": wrote, "effect_bytes_after": os.path.getsize(effect), "writer_after": process(writer_pid)})
    finally:
        if writer is not None:
            current = process(writer["pid"])
            if current and current["birth_lstart"] == writer["birth_lstart"] and current["comm"] == writer["comm"]:
                try:
                    parent.sendall(b"STOP")
                except OSError:
                    pass
                time.sleep(0.1)
                current = process(writer["pid"])
                if current and "Z" not in current["stat"] and current["birth_lstart"] == writer["birth_lstart"]:
                    os.kill(writer["pid"], signal.SIGKILL)
                emit({"cleanup_writer": writer["pid"], "after": process(writer["pid"])})
        if spawned.poll() is None and process(spawned.pid) is not None:
            os.kill(spawned.pid, signal.SIGKILL)
            spawned.wait()
        parent.close()
        stream.close()


if __name__ == "__main__":
    if len(sys.argv) == 1:
        raise SystemExit("usage: race.py oracle EFFECT | coordinator FD EFFECT | scanner ROOT_PID ROOT_PGID")
    if sys.argv[1] == "oracle":
        oracle(os.path.abspath(sys.argv[2]))
    elif sys.argv[1] == "coordinator":
        coordinator(int(sys.argv[2]), sys.argv[3])
    elif sys.argv[1] == "scanner":
        scanner(int(sys.argv[2]), int(sys.argv[3]))
