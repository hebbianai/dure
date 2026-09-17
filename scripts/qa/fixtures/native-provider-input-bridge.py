"""Test-only stalled input consumer; the real provider owns submission."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import termios
import time
import tty

root = Path.cwd()


def publish_receipt(name, payload):
    # Readers use file existence as completion; publish only complete JSON.
    destination = root / name
    pending = destination.with_suffix(".tmp")
    pending.write_text(json.dumps(payload))
    pending.replace(destination)


size = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
tty.setraw(0)
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
publish_receipt("provider-child.json", {"pid": pid, "parentPid": os.getpid()})
fcntl.ioctl(master, termios.TIOCSWINSZ, size)
buffer = bytearray()
holding = False
stopping = False
captured_bytes = 0
capture = (root / "provider-output.bin").open("wb")


def request_stop(_signal, _frame):
    global stopping
    stopping = True


def write_all(fd, data):
    remaining = memoryview(data)
    while remaining:
        remaining = remaining[os.write(fd, remaining):]


signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGHUP, request_stop)
try:
    while not stopping and not (root / "stop-provider").exists():
        ready, _, _ = select.select([0, master], [], [], 0.01)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            if captured_bytes < 1024 * 1024:
                captured_bytes += capture.write(data[:1024 * 1024 - captured_bytes])
                capture.flush()
            write_all(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            if (root / "hold-input").exists():
                holding = True
                buffer.extend(data)
            else:
                write_all(master, data)
        if holding and (root / "release-input").exists():
            while select.select([0], [], [], 0)[0]:
                buffer.extend(os.read(0, 65536))
            write_all(master, buffer)
            buffer.clear()
            holding = False
            (root / "hold-input").unlink()
            (root / "release-input").unlink()
finally:
    capture.close()
    # This direct, unreaped child cannot recycle its PID before waitpid.
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 3
    while True:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
        if waited_pid == pid:
            break
        if time.monotonic() >= deadline:
            os.kill(pid, signal.SIGKILL)
            waited_pid, status = os.waitpid(pid, 0)
            break
        time.sleep(0.01)
    publish_receipt("provider-exit.json", {"waitedPid": waited_pid, "status": status})
    os.close(master)
