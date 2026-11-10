"""`dure tui` against a real managed Hmux session; use run-hmux-tests.mjs.

Uses the workspace's debug binaries unless DURE_QA_HMUX_BIN/RUNTIME name others.
The list, attach, detach and return all run through a real PTY. A synthetic provider echoes what it
receives, so this needs no app, account or desktop focus, and HOME, DURE_HOME and
the discovery root are disposable.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time

SESSION_ID = "dure-tui-smoke"
WORKSPACE_ID = "dure-tui-smoke-workspace"
ENTER_LIST = b"\x1b[?1049h"
LEAVE_LIST = b"\x1b[?1049l"
DETACH = b"\x1cd"

state = Path(os.environ["DURE_HMUX_TEST_STATE_ROOT"])
assert Path(os.environ["HMUX_DISCOVERY_ROOT"]) == state / "hmux-discovery"
root = state / "dure-tui"
root.mkdir(mode=0o700)
home = root / "home"
home.mkdir(mode=0o700)
repo = Path(__file__).resolve().parents[2]
target = repo / os.environ.get("CARGO_TARGET_DIR", "hmux/target") / "debug"
hmux = os.environ.get("DURE_QA_HMUX_BIN", str(target / "hmux"))
runtime = os.environ.get("DURE_QA_HMUX_RUNTIME", str(target / "hmux-runtime"))
environment = dict(os.environ, HOME=str(home), DURE_HOME=str(home / ".dure"),
                   DURE_APP_CHANNEL="stable", DURE_HMUX_BIN=hmux,
                   HMUX_RUNTIME=runtime, TERM="xterm-256color")
for key in list(environment):
    if key.startswith(("DURE_ORCHESTRATION_", "DURE_BACKEND_", "HMUX_SESSION", "HMUX_WORKSPACE",
                       "HMUX_RUNNER", "HMUX_CHANNEL", "HMUX_HOST", "HMUX_TERMINAL", "HEBBIAN_")) or key == "HMUX":
        environment.pop(key)

provider = root / "provider.py"
provider.write_text('''import os, select, sys, time, tty
from pathlib import Path
tty.setraw(0)
sys.stdout.write("TUI-SMOKE-READY\\r\\n")
sys.stdout.flush()
Path("ready").write_text("ready")
received = bytearray()
deadline = time.monotonic() + 60
while time.monotonic() < deadline and not Path("stop").exists():
    if select.select([0], [], [], .02)[0]:
        chunk = os.read(0, 1024)
        if not chunk: break
        received.extend(chunk)
        Path("received").write_text(received.hex())
        sys.stdout.write("GOT-" + chunk.hex() + "\\r\\n")
        sys.stdout.flush()
Path("exited").write_text("exited")
''')


def wait_file(name):
    deadline = time.monotonic() + 10
    while not (root / name).exists():
        assert time.monotonic() < deadline, f"provider did not publish {name}"
        time.sleep(.02)
    return (root / name).read_text()


class Terminal:
    """One `dure tui` process on its own PTY."""

    def __init__(self, argv):
        self.data = b""
        self.status = None
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            os.chdir(root)
            os.execve(argv[0], argv, environment)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))

    def pump(self, wait):
        if not select.select([self.master], [], [], wait)[0]:
            return
        try:
            chunk = os.read(self.master, 65536)
        except OSError:
            chunk = b""
        if chunk:
            self.data += chunk
        else:
            time.sleep(.02)

    def expect(self, needles, label, start=0, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            view = self.data[start:]
            if all(needle in view for needle in needles):
                return view
            self.pump(.05)
        raise AssertionError(f"{label}: missing {needles!r} in {self.data[start:][-2000:]!r}")

    def send(self, payload):
        os.write(self.master, payload)

    def wait_exit(self, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(.02)
            exited, status = os.waitpid(self.pid, os.WNOHANG)
            if exited:
                self.status = status
                self.pump(0)
                return os.waitstatus_to_exitcode(status)
        raise AssertionError("dure tui did not exit")

    def stop(self):
        if self.status is not None:
            return
        for action in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self.pid, action)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                exited, status = os.waitpid(self.pid, os.WNOHANG)
                if exited:
                    self.status = status
                    return
                time.sleep(.02)


request = {
    "schema": "hmux-managed-create-v1", "schemaVersion": 1,
    "idempotencyKey": SESSION_ID, "sessionId": SESSION_ID,
    "workspaceId": WORKSPACE_ID, "providerId": "test-provider",
    "permissionMode": "default", "providerCwd": str(root),
    "command": [sys.executable, str(provider)], "initialRows": 24, "initialColumns": 80,
}


def runtime_operation(name, body):
    encoded = json.dumps(body).encode()
    done = subprocess.run([runtime, "--no-autostart", f"internal-hmux-managed-{name}"],
                          input=len(encoded).to_bytes(4, "big") + encoded,
                          capture_output=True, env=environment, cwd=root, timeout=20)
    assert done.returncode == 0, done.stderr.decode()
    return json.loads(done.stdout[4:])


def exact_fence():
    listed = subprocess.run([hmux, "--discovery-root", os.environ["HMUX_DISCOVERY_ROOT"], "--json", "ls"],
                            capture_output=True, env=environment, cwd=root, timeout=20, text=True)
    assert listed.returncode == 0, listed.stderr
    session = next(item for item in json.loads(listed.stdout) if item["session_id"] == SESSION_ID)
    return {key: session[key] for key in ("workspace_id", "session_id", "runner_principal", "runner_instance",
                                          "channel_epoch", "host_instance_id", "terminal_epoch")}


def report_state(fence, activity, attention="none"):
    report = {"request_id": f"dure-tui-{activity}-{attention}", "identity_only": False, "activity": activity,
              "attention": attention, "turn_completed": False}
    if activity == "working":
        report["working_ttl_ms"] = "86400000"
    receipt = runtime_operation("agent-state-report", {
        "schema": "hmux-managed-agent-state-report-v1", "schemaVersion": 1,
        "expectedFence": fence, "report": report})
    assert receipt["state"] == "completed", receipt


terminal = None
try:
    created = runtime_operation("create", request)
    assert created["state"] == "completed", created
    wait_file("ready")
    fence = exact_fence()

    terminal = Terminal([shutil.which("node"), str(repo / "cli/dure.mjs"), "tui"])
    listed = terminal.expect([ENTER_LIST, b"STATE", b"ACCOUNT", b"PROJECT", SESSION_ID.encode(), b"1 agent"],
                             "the list did not show the managed agent")
    assert b"> " in listed, "the agent row is not selected"
    screen = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"\n", listed).decode(errors="replace")
    row = next(line.strip() for line in screen.splitlines() if SESSION_ID in line)
    print(f"DURE_TUI_ROW: {' '.join(row.split())}", flush=True)

    # The Host's own reports, picked up by the list's automatic refresh. It keeps
    # an open attention episode through a plain waiting report, so that comes last.
    for activity, attention, shown in (("working", "none", b"> working"),
                                       ("waiting", "none", b"> idle"),
                                       ("waiting", "input_required", b"> needs input")):
        mark = len(terminal.data)
        report_state(fence, activity, attention)
        terminal.expect([shown], f"the list did not show {shown!r}", mark)

    for attempt in range(2):
        mark = len(terminal.data)
        terminal.send(b"\r")
        terminal.expect([LEAVE_LIST, b"TUI-SMOKE-READY"], f"attach {attempt} did not show the agent", mark)

        if attempt == 0:
            mark = len(terminal.data)
            terminal.send(b"x")
            terminal.expect([b"GOT-78"], "the agent did not echo attached input", mark)
            assert wait_file("received") == "78", "attached input did not reach the agent"
        else:
            # The second attach repaints the same live terminal.
            terminal.expect([b"GOT-78"], "reattach did not restore the agent's screen", mark)

        mark = len(terminal.data)
        terminal.send(DETACH)
        back = terminal.expect([ENTER_LIST, b"STATE", SESSION_ID.encode()],
                               f"detach {attempt} did not return to the list", mark)
        assert back.index(ENTER_LIST) < back.index(b"STATE"), "list painted before re-entering its screen"
        assert not (root / "exited").exists(), "detaching stopped the agent"

    # Across backends: without a backend catalog this machine is listed as local,
    # read through the same Hmux, and the list does not write a catalog.
    every = Terminal([shutil.which("node"), str(repo / "cli/dure.mjs"), "tui", "--all-backends"])
    try:
        listed = every.expect([ENTER_LIST, b"BACKEND", b"local", SESSION_ID.encode(), b"1 agent"],
                              "the list across backends did not show the agent")
        screen = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"\n", listed).decode(errors="replace")
        row = next(line.strip() for line in screen.splitlines() if SESSION_ID in line)
        assert " local " in f" {row} ", f"the row does not name its backend: {row!r}"
        print(f"DURE_TUI_ALL_BACKENDS_ROW: {' '.join(row.split())}", flush=True)
        mark = len(every.data)
        every.send(b"\r")
        every.expect([LEAVE_LIST, b"GOT-78"], "attach across backends did not show the agent", mark)
        mark = len(every.data)
        every.send(b"y")
        every.expect([b"GOT-79"], "the agent did not echo input attached across backends", mark)
        assert wait_file("received") == "7879", "input attached across backends did not reach the agent"
        mark = len(every.data)
        every.send(DETACH)
        every.expect([ENTER_LIST, b"BACKEND", SESSION_ID.encode()],
                     "detach across backends did not return to the list", mark)
        assert not (root / "exited").exists(), "detaching across backends stopped the agent"
        mark = len(every.data)
        every.send(b"q")
        assert every.wait_exit() == 0, every.data[-2000:]
        assert LEAVE_LIST in every.data[mark:], "quitting across backends did not restore the terminal"
        assert not (home / ".dure" / "backend-profiles.json").exists(), "listing across backends wrote a catalog"
    finally:
        every.stop()

    mark = len(terminal.data)
    (root / "stop").write_text("stop")
    wait_file("exited")
    terminal.expect([b"> exited"], "the list did not show the agent exit", mark)
    mark = len(terminal.data)
    terminal.send(b"\r")
    terminal.expect([b"has exited"], "Enter on an exited agent gave no reason", mark)
    assert LEAVE_LIST not in terminal.data[mark:], "attached to an exited agent"

    mark = len(terminal.data)
    terminal.send(b"q")
    assert terminal.wait_exit() == 0, terminal.data[-2000:]
    assert LEAVE_LIST in terminal.data[mark:], "quitting did not restore the terminal"
    assert not (home / ".dure" / "agents.json").exists(), "the smoke must run without an app registry"
    print("DURE_TUI_PASS: every state, attach, input, detach, return and reattach on a real managed session, "
          "on one backend and across backends")
finally:
    if terminal is not None:
        terminal.stop()
    (root / "stop").write_text("stop")
    if (root / "ready").exists():
        wait_file("exited")
    # The outer guardian verifies exact Host retirement in its disposable root.
