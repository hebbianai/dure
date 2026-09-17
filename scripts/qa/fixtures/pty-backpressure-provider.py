"""Account-free PTY peer; its independent deadline bounds even the RED path."""

import os
import sys
import threading
import tty


def mark(name):
    with open(name, "x", encoding="utf-8") as marker:
        marker.write(name)


def expire():
    mark("expired")
    os._exit(124)


def read_exact(size):
    result = b""
    while len(result) < size:
        chunk = os.read(0, size - len(result))
        if not chunk:
            raise EOFError("PTY closed before the expected bytes arrived")
        result += chunk
    return result


def write_all(value):
    pending = memoryview(value)
    while pending:
        pending = pending[os.write(1, pending):]


threading.Timer(15, expire).start()
tty.setraw(0)
mark("ready")
assert read_exact(1) == b"x"
mode = sys.argv[1]
if mode == "reply":
    write_all(b"\x1b[5n" * (16 * 1024))
    assert read_exact(64 * 1024) == b"\x1b[0n" * (16 * 1024)
else:
    size = 64 if mode == "control" else 64 * 1024
    write_all(b"." * (256 * 1024))
    assert read_exact(size - 1) == b"x" * (size - 1)
mark("complete")
read_exact(1)
