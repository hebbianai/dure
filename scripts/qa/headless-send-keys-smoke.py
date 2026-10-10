"""Real managed PTY input without any app registry; use run-hmux-tests.mjs.

Set DURE_QA_HMUX_BIN/RUNTIME to compatible installed native binaries. The
synthetic provider records bytes, so this needs no app, account or desktop focus.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

state = Path(os.environ["DURE_HMUX_TEST_STATE_ROOT"])
assert Path(os.environ["HMUX_DISCOVERY_ROOT"]) == state / "hmux-discovery"
root = state / "headless-keys"
root.mkdir(mode=0o700)
home = root / "home"
home.mkdir(mode=0o700)
environment = dict(os.environ, HOME=str(home), DURE_HOME=str(home / ".dure"),
                   DURE_APP_CHANNEL="stable", DURE_HMUX_BIN=os.environ["DURE_QA_HMUX_BIN"])
for key in list(environment):
    if key.startswith(("DURE_ORCHESTRATION_", "DURE_BACKEND_", "HMUX_SESSION", "HMUX_WORKSPACE",
                       "HMUX_RUNNER", "HMUX_CHANNEL", "HMUX_HOST", "HMUX_TERMINAL", "HEBBIAN_")) or key == "HMUX":
        environment.pop(key)
provider = root / "provider.py"
provider.write_text('''import os, select, time, tty
from pathlib import Path
tty.setraw(0)
Path("ready").write_text("ready")
received = bytearray()
deadline = time.monotonic() + 30
while time.monotonic() < deadline and not Path("stop").exists():
    if select.select([0], [], [], .02)[0]:
        chunk = os.read(0, 1024)
        if not chunk: break
        received.extend(chunk)
        Path("received").write_text(received.hex())
Path("exited").write_text("exited")
''')


def wait_file(name):
    deadline = time.monotonic() + 5
    while not (root / name).exists():
        assert time.monotonic() < deadline, f"provider did not publish {name}"
        time.sleep(.02)
    return (root / name).read_text()


request = {
    "schema": "hmux-managed-create-v1", "schemaVersion": 1,
    "idempotencyKey": "headless-keys", "sessionId": "headless-keys",
    "workspaceId": "headless-keys-workspace", "providerId": "test-provider",
    "permissionMode": "default", "providerCwd": str(root),
    "command": [sys.executable, str(provider)], "initialRows": 24, "initialColumns": 80,
}
encoded = json.dumps(request).encode()
repo = Path(__file__).resolve().parents[2]
try:
    created = subprocess.run([os.environ["DURE_QA_HMUX_RUNTIME"], "--no-autostart", "internal-hmux-managed-create"],
                             input=len(encoded).to_bytes(4, "big") + encoded,
                             capture_output=True, env=environment, cwd=root, timeout=20)
    assert created.returncode == 0, created.stderr.decode()
    assert json.loads(created.stdout[4:])["state"] == "completed", created.stdout.decode(errors="replace")
    wait_file("ready")
    assert not (home / ".dure" / "agents.json").exists()
    result = subprocess.run([shutil.which("node"), str(repo / "cli/dure.mjs"), "send-keys",
                             "headless-keys", "Down", "Enter", "--workspace", "headless-keys-workspace", "--json"],
                            cwd=root, env=environment, text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    receipt = json.loads(result.stdout)
    assert receipt["ok"] is True
    assert receipt["target"] == {"sessionId": "headless-keys", "workspaceId": "headless-keys-workspace"}
    assert [key["state"] for key in receipt["receipt"]["keys"]] == ["written_to_pty", "written_to_pty"]
    deadline = time.monotonic() + 5
    while wait_file("received") != "1b5b420d":
        assert time.monotonic() < deadline, "unexpected semantic key bytes"
        time.sleep(.02)
    print("HEADLESS_SEND_KEYS_PASS: exact Down/Enter bytes received without a pane or registry")
finally:
    (root / "stop").write_text("stop")
    if (root / "ready").exists():
        wait_file("exited")
    # The outer guardian verifies exact Host retirement in its disposable root.
