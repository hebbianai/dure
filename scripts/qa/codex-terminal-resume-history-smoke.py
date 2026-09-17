"""Verify native Codex terminal history after model, effort and permission edits.

Uses synthetic persisted messages, a disposable HOME and a loopback-only provider
configuration. No model turn, real credential, live pane or installed config is used.
"""

import argparse
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import runpy
import select
import signal
import struct
import tempfile
import termios
import time
import uuid


def stop_child(pid):
    # pid is an unreaped child created by this invocation; it cannot be reused.
    for action in (signal.SIGTERM, signal.SIGKILL):
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            return status
        try:
            os.kill(pid, action)
        except ProcessLookupError:
            return os.waitpid(pid, 0)[1]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited:
                return status
            time.sleep(.02)
    raise RuntimeError("owned native terminal did not exit")


def printed_messages(data, marker):
    plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", data).decode("utf-8", errors="replace")
    return f"› {marker}" in plain, f"Completed: {marker}" in plain


def terminal_resume(executable, root, thread_id, label, settings, marker):
    environment = {
        "PATH": os.defpath, "HOME": str(root / "home"),
        "CODEX_HOME": str(root / "codex"), "CODEX_SQLITE_HOME": str(root / "codex"),
        "DURE_HOME": str(root / "dure"), "HMUX_DISCOVERY_ROOT": str(root / "discovery"),
        "TMPDIR": str(root / "tmp"), "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
    }
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(root / "home")
        os.execve(executable, [str(executable), "--no-alt-screen", *settings, "resume", thread_id], environment)
    print(json.dumps({"case": label, "pid": pid, "cwd": environment["HOME"],
                      "executable": str(executable)}), flush=True)
    data, pending = b"", b""
    deadline = time.monotonic() + 30
    last_output = time.monotonic()
    status = None
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                data += chunk
                if len(data) > 1024 * 1024:
                    raise RuntimeError("native terminal exceeded fixture output budget")
                last_output = time.monotonic()
                pending += chunk
                for query, reply in [
                    (b"\x1b[6n", b"\x1b[1;1R"),
                    (b"\x1b[c", b"\x1b[?1;2c"),
                    (b"\x1b[>0c", b"\x1b[>0;0;0c"),
                    (b"\x1b]10;?\x1b\\", b"\x1b]10;rgb:dddd/dddd/dddd\x1b\\"),
                    (b"\x1b]11;?\x1b\\", b"\x1b]11;rgb:0000/0000/0000\x1b\\"),
                ]:
                    if query in pending:
                        os.write(master, reply)
                        pending = pending.replace(query, b"")
                pending = pending[-100:]
            exited, status = os.waitpid(pid, os.WNOHANG)
            if exited:
                pid = None
                raise RuntimeError(f"native terminal exited before inspection: {status}")
            if all(printed_messages(data, marker)) and time.monotonic() - last_output > .5:
                break
    finally:
        try:
            if pid is not None:
                status = stop_child(pid)
        finally:
            os.close(master)
            (root / f"{label}.ansi").write_bytes(data)
    user_printed, answer_printed = printed_messages(data, marker)
    return {"case": label, "threadId": thread_id, "settings": settings,
            "latestUserMessagePrinted": user_printed, "latestAnswerPrinted": answer_printed,
            "bytes": len(data), "exitStatus": status}


def check(executable, root):
    fixture = runpy.run_path(str(Path(__file__).with_name("codex-account-resume-history-smoke.py")))
    for name in ("home", "codex", "tmp"):
        (root / name).mkdir()
    sessions = root / "codex" / "sessions"
    sessions.mkdir()
    thread_id = str(uuid.uuid4())
    rollout = sessions / f"rollout-2026-09-01T00-00-00-{thread_id}.jsonl"
    records = [fixture["record"](0, "session_meta", {
        "id": thread_id, "timestamp": "2026-09-01T00:00:00.000Z", "cwd": str(root / "home"),
        "originator": "dure-terminal-history-fixture", "cli_version": "0.154.0-alpha.3",
        "source": "cli", "thread_source": "user", "model_provider": "fixture",
        "history_mode": "paginated", "base_instructions": {"text": "Synthetic history only."},
    })]
    # Distinguish the latest task from older persisted work in a paginated thread.
    for index in range(35):
        marker = f"Current-task-{index:02}"
        records.extend(fixture["turn_records"](len(records), thread_id, f"turn-{index}", marker))
    fixture["append_records"](rollout, records)
    (root / "codex" / "config.toml").write_text(
        'model_provider="fixture"\ncheck_for_update_on_startup=false\n'
        '[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:9/v1"\n'
        'wire_api="responses"\nrequires_openai_auth=false\n'
        f'[projects.{json.dumps(str(root / "home"))}]\ntrust_level="trusted"\n'
    )
    cases = [
        ("before", ["--model", "gpt-6-astra", "--ask-for-approval", "never"]),
        ("model", ["--model", "gpt-5.6-sol", "--ask-for-approval", "never"]),
        ("effort", ["--model", "gpt-5.6-sol", "--ask-for-approval", "never", "-c", 'model_reasoning_effort="high"']),
        ("permission", ["--model", "gpt-5.6-sol", "--ask-for-approval", "on-request", "-c", 'model_reasoning_effort="high"']),
    ]
    results = [terminal_resume(executable, root, thread_id, label, settings, marker)
               for label, settings in cases]
    return {"ok": all(item["latestUserMessagePrinted"] and item["latestAnswerPrinted"] for item in results),
            "cases": results, "modelTurnsRequested": 0, "realCredentialsUsed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True, type=Path)
    args = parser.parse_args()
    if not args.codex.is_absolute() or not args.codex.is_file():
        parser.error("--codex must name an existing absolute native executable")
    executable = args.codex.resolve()
    root = Path(tempfile.mkdtemp(prefix="dure-codex-terminal-history-")).resolve()
    digest = hashlib.sha256()
    with executable.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    receipt = {"executable": str(executable), "sha256": digest.hexdigest(), "artifacts": str(root)}
    try:
        receipt.update(check(executable, root))
    except Exception as error:
        receipt.update(ok=False, error=str(error))
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt), flush=True)
    return 0 if receipt["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
