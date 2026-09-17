"""Native PTY peer: explicit paste framing survives arbitrarily coalesced reads.

The harness releases interpretation only after the PTY write receipts. Unframed
text is treated as a paste burst, including Enter; framed paste leaves Enter as
one separate submission. Evidence is written by this input consumer, not scraped
from its terminal display.
"""
import json
import os
from pathlib import Path
import select
import time
import tty

root = Path.cwd()
tty.setraw(0)
os.set_blocking(0, False)
os.write(1, b"\x1b[?2004h\x1b[5n")
received = bytearray()
deadline = time.monotonic() + 30
while b"\x1b[0n" not in received:
    assert time.monotonic() < deadline, "Host did not acknowledge terminal modes"
    if select.select([0], [], [], 0.05)[0]:
        received.extend(os.read(0, 65536))
(root / "ready").write_text("ready")
received.clear()
draft = bytearray()
submissions = []
step = 0
while time.monotonic() < deadline:
    if select.select([0], [], [], 0.01)[0]:
        data = os.read(0, 65536)
        if not data:
            break
        received.extend(data)
    release = root / f"release-{step}.json"
    if not release.exists():
        continue
    # Drain the bytes already acknowledged by the Host before interpreting.
    while select.select([0], [], [], 0)[0]:
        received.extend(os.read(0, 65536))
    chunk = bytes(received)
    received.clear()
    cursor = 0
    while cursor < len(chunk):
        if chunk.startswith(b"\x1b[200~", cursor):
            end = chunk.index(b"\x1b[201~", cursor + 6)
            draft.extend(chunk[cursor + 6:end].replace(b"\r", b"\n"))
            cursor = end + 6
        elif chunk[cursor:] == b"\r":
            submissions.append(draft.decode())
            draft.clear()
            cursor += 1
        else:
            # A raw multi-character burst owns its embedded Enter/newlines.
            draft.extend(chunk[cursor:])
            cursor = len(chunk)
    result = {"draft": draft.decode(), "submissions": submissions, "bytes": len(chunk)}
    destination = root / f"result-{step}.json"
    temporary = root / "result.tmp"
    temporary.write_text(json.dumps(result, ensure_ascii=False))
    temporary.rename(destination)
    step += 1
