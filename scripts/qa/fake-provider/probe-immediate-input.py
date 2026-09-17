#!/usr/bin/env python3
"""Prove a fake provider paints one character through a real pseudo-terminal."""

import os
import pty
import select
import subprocess
import sys
import time


def read_until(master: int, output: bytearray, marker: bytes, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while marker not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"timed out waiting for {marker!r}")
        readable, _, _ = select.select([master], [], [], remaining)
        if not readable:
            continue
        output.extend(os.read(master, 4096))


def main() -> int:
    if len(sys.argv) != 2:
        raise ValueError("usage: probe-immediate-input.py <provider>")
    master, slave = pty.openpty()
    process = subprocess.Popen(
        [sys.argv[1]],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        env=os.environ,
    )
    os.close(slave)
    output = bytearray()
    try:
        # Shell/process startup may contend with native QA builds. The strict
        # latency contract begins only after the prompt is observable.
        read_until(master, output, b"> ", 5.0)
        os.write(master, b"~")
        read_until(master, output, b"> ~", 0.3)
        sys.stdout.buffer.write(output)
        return 0
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=1.0)
        os.close(master)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
