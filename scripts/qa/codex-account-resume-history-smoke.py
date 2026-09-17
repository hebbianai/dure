"""Check native Codex history continuity across account homes, without credentials.

Run with --codex /absolute/path/to/native/codex. All data is synthetic; the
provider only resumes and changes settings. No model turn or live file is used.
Receipts and provider logs remain in a fresh, owner-only temporary directory.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import uuid


class AppServer:
    def __init__(self, executable, root, account, canonical):
        self.log = (root / f"{account.name}.log").open("wb")
        environment = {
            "PATH": os.defpath,
            "HOME": str(root / "home"),
            "CODEX_HOME": str(account),
            "CODEX_SQLITE_HOME": str(canonical),
            "DURE_HOME": str(root / "dure"),
            "HMUX_DISCOVERY_ROOT": str(root / "discovery"),
            "DURE_APP_CHANNEL": "qa-codex-resume-history",
            "VITE_DURE_APP_CHANNEL": "qa-codex-resume-history",
            "TMPDIR": str(root),
        }
        self.child = subprocess.Popen(
            [str(executable), "app-server", "--stdio"],
            cwd=root / "home", env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
        )
        print(json.dumps({"pid": self.child.pid, "cwd": environment["HOME"],
                          "executable": str(executable)}), flush=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.child.stdout, selectors.EVENT_READ)
        self.pending = b""
        self.sequence = 0

    def send(self, message):
        self.child.stdin.write((json.dumps(message) + "\n").encode())
        self.child.stdin.flush()

    def call(self, method, params):
        self.sequence += 1
        self.send({"id": self.sequence, "method": method, "params": params})
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if b"\n" not in self.pending:
                if not self.selector.select(max(0, min(1, deadline - time.monotonic()))):
                    continue
                chunk = os.read(self.child.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError(f"app-server exited during {method}")
                self.pending += chunk
                if len(self.pending) > 4 * 1024 * 1024:
                    raise RuntimeError("fixture response exceeded 4 MiB")
                continue
            line, self.pending = self.pending.split(b"\n", 1)
            message = json.loads(line)
            if message.get("id") != self.sequence:
                continue
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error']}")
            return message["result"]
        raise RuntimeError(f"app-server timed out during {method}")

    def close(self):
        self.child.stdin.close()
        try:
            try:
                self.child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                # This unreaped child is the exact process created above;
                # cleanup never discovers or signals another provider process.
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=5)
                raise RuntimeError("app-server did not exit after closing stdin")
        finally:
            self.selector.close()
            self.child.stdout.close()
            self.log.close()
        if self.child.returncode != 0:
            raise RuntimeError(f"app-server exited with {self.child.returncode}")


def record(ordinal, kind, payload):
    return {"timestamp": "2026-09-01T00:00:00.000Z", "ordinal": ordinal,
            "type": kind, "payload": payload}


def turn_records(ordinal, thread_id, turn_id, text):
    answer = f"Completed: {text}"
    return [
        record(ordinal, "event_msg", {
            "type": "task_started", "turn_id": turn_id,
            "started_at": 1788220800, "collaboration_mode_kind": "default",
        }),
        record(ordinal + 1, "response_item", {
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": text}],
        }),
        record(ordinal + 2, "event_msg", {
            "type": "item_completed", "thread_id": thread_id, "turn_id": turn_id,
            "item": {"type": "UserMessage", "id": f"{turn_id}-user", "content": [
                {"type": "text", "text": text, "text_elements": []},
            ]},
            "started_at_ms": 1788220800000, "completed_at_ms": 1788220800000,
        }),
        record(ordinal + 3, "response_item", {
            "type": "message", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "output_text", "text": answer}],
        }),
        record(ordinal + 4, "event_msg", {
            "type": "item_completed", "thread_id": thread_id, "turn_id": turn_id,
            "item": {"type": "AgentMessage", "id": f"{turn_id}-agent", "content": [
                {"type": "Text", "text": answer},
            ], "phase": "final_answer"},
            "started_at_ms": 1788220800000, "completed_at_ms": 1788220801000,
        }),
        record(ordinal + 5, "event_msg", {
            "type": "task_complete", "turn_id": turn_id,
            "started_at": 1788220800, "completed_at": 1788220801,
            "duration_ms": 1000, "last_agent_message": answer,
        }),
    ]


def token_count(ordinal):
    # Keep the decimal spelling. Direct Serde decoding of the flattened
    # RolloutLine rejects this otherwise valid persisted provider record.
    return record(ordinal, "event_msg", {
        "type": "token_count", "info": None,
        "rate_limits": {"limit_id": "codex", "primary": {
            "used_percent": 0.0, "window_minutes": 300, "resets_at": 1788220800,
        }},
    })


def append_records(rollout, records):
    with rollout.open("a") as destination:
        for item in records:
            destination.write(json.dumps(item) + "\n")


def resume(executable, root, account, canonical, thread_id, rollout):
    server = AppServer(executable, root, account, canonical)
    try:
        initialized = server.call("initialize", {
            "clientInfo": {"name": "dure-history-fixture", "version": "1.0"},
            "capabilities": {"experimentalApi": True},
        })
        server.send({"method": "initialized", "params": {}})
        resumed = server.call("thread/resume", {
            "threadId": thread_id, "path": str(rollout), "excludeTurns": True,
            "model": "gpt-6-astra", "approvalPolicy": "never", "sandbox": "read-only",
            "cwd": str(root / "home"),
        })
        if resumed["thread"]["id"] != thread_id:
            raise RuntimeError("resume substituted a different thread")
        settings_history = []
        for kind, update in [
            ("model", {"model": "gpt-5.6-sol"}),
            ("effort", {"effort": "high"}),
            ("permission", {"approvalPolicy": "on-request"}),
        ]:
            server.call("thread/settings/update", {"threadId": thread_id, **update})
            observed = server.call("thread/read", {
                "threadId": thread_id, "includeTurns": False,
            })
            if observed["thread"]["id"] != thread_id:
                raise RuntimeError(f"{kind} change substituted a different thread")
            turns = server.call("thread/turns/list", {
                "threadId": thread_id, "limit": 3,
                "itemsView": "full", "sortDirection": "desc",
            })
            settings_history.append({
                "kind": kind, "threadId": observed["thread"]["id"],
                "turnIds": [turn["id"] for turn in turns["data"]],
                "latestItems": turns["data"][0]["items"] if turns["data"] else [],
            })
        return {"userAgent": initialized["userAgent"], "turns": turns,
                "settingsHistory": settings_history}
    finally:
        server.close()


def check(executable, root):
    canonical = root / "canonical"
    sessions = canonical / "sessions"
    sessions.mkdir(parents=True)
    (root / "home").mkdir()
    accounts = [root / "account-a", root / "account-b"]
    for account in accounts:
        account.mkdir()
        (account / "sessions").symlink_to(sessions, target_is_directory=True)
    thread_id = str(uuid.uuid4())
    rollout = sessions / f"rollout-2026-09-01T00-00-00-{thread_id}.jsonl"
    append_records(rollout, [record(0, "session_meta", {
        "id": thread_id, "timestamp": "2026-09-01T00:00:00.000Z",
        "cwd": str(root / "home"), "originator": "dure-history-fixture",
        "cli_version": "0.153.4", "source": "cli", "thread_source": "user",
        "model_provider": "openai", "history_mode": "paginated",
        "base_instructions": {"text": "Synthetic fixture. No model turns."},
    }), *turn_records(1, thread_id, "older-work", "Earlier synthetic work."), token_count(7)])
    first = resume(executable, root, accounts[0], canonical, thread_id, rollout)
    initial = [json.loads(line) for line in rollout.read_text().splitlines()]
    # Add later durable work after the first process exits. Both providers see
    # the same valid fixture suffix; only the native resume write differs.
    ordinal = initial[-1]["ordinal"] + 1
    append_records(rollout, [
        *turn_records(ordinal, thread_id, "command-n-work", "Continue Command+N UI/UX."),
        token_count(ordinal + 6),
    ])
    second = resume(executable, root, accounts[1], canonical, thread_id, rollout)
    records = [json.loads(line) for line in rollout.read_text().splitlines()]
    ordinals = [line["ordinal"] for line in records]
    visible = [turn["id"] for turn in second["turns"]["data"]]
    failures = []
    if ordinals != list(range(len(records))):
        failures.append("native resume reused a durable rollout ordinal")
    if (not visible or visible[0] != "command-n-work" or any(
            not item["turnIds"] or item["turnIds"][0] != "command-n-work"
            or not latest_messages_match(item["latestItems"])
            for item in second["settingsHistory"])):
        failures.append("second account resumed stale displayed history")
    return {
        "ok": not failures, "failures": failures, "threadId": thread_id,
        "firstResume": first, "secondResume": second, "ordinals": ordinals,
        "accountsShareCanonicalHistory": True,
        "modelTurnsRequested": 0, "realCredentialsUsed": False,
    }


def latest_messages_match(items):
    users = [item for item in items if item.get("type") == "userMessage"]
    agents = [item for item in items if item.get("type") == "agentMessage"]
    return (
        len(users) == 1 and len(agents) == 1
        and users[0].get("content") == [{"type": "text", "text": "Continue Command+N UI/UX.", "text_elements": []}]
        and agents[0].get("text") == "Completed: Continue Command+N UI/UX."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True, type=Path,
                        help="Absolute path to the native Codex executable")
    args = parser.parse_args()
    if not args.codex.is_absolute() or not args.codex.is_file():
        parser.error("--codex must name an existing absolute executable path")
    executable = args.codex.resolve()
    root = Path(tempfile.mkdtemp(prefix="dure-codex-resume-history-")).resolve()
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
    sys.exit(main())
