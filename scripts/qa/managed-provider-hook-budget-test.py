"""Process-level regression for the managed hook's three-second caller budget.

Uses disposable provider/runtime executables, no live session or credentials.
Run with: python3 scripts/qa/managed-provider-hook-budget-test.py
"""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


HOOK = Path(__file__).resolve().parents[2] / "src-tauri/resources/managed-claude-hook.py"


class ManagedHookBudgetTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="dure-hook-budget-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.environment = {
            "PATH": str(self.root) + os.pathsep + os.defpath,
            "HOME": str(self.root),
            "DURE_HOME": str(self.root),
            "HMUX_DISCOVERY_ROOT": str(self.root / "discovery"),
            "HMUX_SESSION_ID": "hook-budget-session",
            "HMUX_WORKSPACE_ID": "hook-budget-workspace",
            "HMUX_RUNNER_PRINCIPAL": "fixture-user",
            "HMUX_RUNNER_INSTANCE": "fixture-runner",
            "HMUX_CHANNEL_EPOCH": "1",
            "HMUX_HOST_INSTANCE_ID": "fixture-host",
            "HMUX_TERMINAL_EPOCH": "fixture-terminal",
        }
        self.executable("codex", """
import time
Path('provider-started').touch()
time.sleep(30)
""")
        runtime = self.executable("runtime", """
import json, os, time
body = sys.stdin.buffer.read()
request = json.loads(body[4:])
Path('report.json').write_text(json.dumps(request))
with Path('reports.jsonl').open('a') as reports:
    reports.write(json.dumps(request) + '\\n')
time.sleep(float(os.environ.get('REPORT_DELAY', '0')))
Path('acknowledged').touch()
reply = json.dumps({'state': 'completed'}).encode()
sys.stdout.buffer.write(len(reply).to_bytes(4, 'big') + reply)
""")
        self.hook = self.root / "managed-codex-notify.sh"
        self.hook.write_text(HOOK.read_text().replace(
            '"__DURE_HMUX_RUNTIME_EXECUTABLE__"', json.dumps(str(runtime)),
        ))

    def executable(self, name, body):
        target = self.root / name
        target.write_text(f"#!{sys.executable}\nimport sys\nfrom pathlib import Path\n" + body)
        target.chmod(0o700)
        return target

    def invoke(self, payload, *, args=(), input_delay=0, report_delay=0):
        # The isolated process group belongs only to this fixture invocation.
        # Kill/reap it even when the caller's deadline interrupts the old hook.
        with subprocess.Popen(
            [sys.executable, str(self.hook), *args],
            cwd=self.root,
            env={**self.environment, "REPORT_DELAY": str(report_delay)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        ) as child:
            started = time.monotonic()
            try:
                time.sleep(input_delay)
                stdout, stderr = child.communicate(
                    json.dumps(payload).encode() if payload is not None else b"",
                    timeout=max(0.01, 3 - (time.monotonic() - started)),
                )
                self.assertEqual(child.returncode, 0, stderr.decode())
                self.assertEqual(stdout, b"")
                return time.monotonic() - started
            except subprocess.TimeoutExpired:
                self.fail("managed hook exceeded its caller's 3-second budget")
            finally:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.communicate()

    def test_notify_and_goal_lookup_share_the_callers_deadline(self):
        self.invoke(None, args=[json.dumps({
            "type": "agent-turn-complete", "thread-id": "conversation-stop",
            "turn-id": "turn-stop-1", "last-assistant-message": "done",
        })], report_delay=1.2)
        self.assertTrue((self.root / "provider-started").exists())
        self.assertFalse((self.root / "acknowledged").exists())
        request = json.loads((self.root / "report.json").read_text())
        self.assertEqual(len((self.root / "reports.jsonl").read_text().splitlines()), 1)
        self.assertEqual(request["expectedFence"]["terminal_epoch"], "fixture-terminal")
        self.assertEqual(request["report"]["request_id"], "turn-stop-1")
        self.assertEqual(request["report"]["activity"], "waiting")
        self.assertFalse(request["report"]["turn_completed"])
        self.assertNotIn("turn_completion_id", request["report"])

    def test_input_and_reporting_share_one_deadline(self):
        self.invoke({
            "hook_event_name": "UserPromptSubmit", "session_id": "conversation-start",
            "turn_id": "turn-start-1",
        }, input_delay=1.4, report_delay=2)
        self.assertTrue((self.root / "report.json").exists())
        self.assertFalse((self.root / "acknowledged").exists())

    def test_interrupt_settles_the_same_turn_without_goal_lookup_or_completion(self):
        identity = {"session_id": "conversation-interrupt", "turn_id": "turn-interrupt-1"}
        self.invoke({"hook_event_name": "UserPromptSubmit", **identity})
        self.invoke({"hook_event_name": "Interrupt", **identity})
        reports = [json.loads(line) for line in (self.root / "reports.jsonl").read_text().splitlines()]
        self.assertEqual(len(reports), 2)
        self.assertEqual(reports[0]["report"]["activity"], "working")
        self.assertEqual(reports[1]["expectedFence"], reports[0]["expectedFence"])
        self.assertEqual(reports[1]["report"], {
            "request_id": identity["turn_id"], "identity_only": False,
            "activity": "waiting", "attention": "none", "turn_completed": False,
            "conversation_identity": {
                "provider_id": "codex", "conversation_id": identity["session_id"],
            },
        })
        self.assertFalse((self.root / "provider-started").exists())

    def test_interrupt_rejects_missing_or_invalid_identity(self):
        for identity in (
            {"session_id": "conversation-interrupt"},
            {"session_id": "conversation-interrupt", "turn_id": "invalid/turn"},
            {"session_id": "invalid/conversation", "turn_id": "turn-interrupt-1"},
        ):
            with self.subTest(identity=identity):
                self.invoke({"hook_event_name": "Interrupt", **identity})
                self.assertFalse((self.root / "report.json").exists())
                self.assertFalse((self.root / "provider-started").exists())

    def test_legacy_user_notify_is_preserved_after_goal_lookup_timeout(self):
        notify = self.executable("notify", "Path('user-notify').write_text(sys.argv[1])\n")
        payload = json.dumps({
            "type": "agent-turn-complete", "thread-id": "conversation-notify",
            "turn-id": "turn-notify-1", "last-assistant-message": "continuing",
        })
        self.invoke(None, args=[str(notify), payload])
        self.assertEqual((self.root / "user-notify").read_text(), payload)
        self.assertTrue((self.root / "provider-started").exists())

    def test_invalid_identity_does_not_launch_runtime(self):
        self.invoke(None, args=[json.dumps({
            "type": "agent-turn-complete", "thread-id": "conversation-stop",
            "turn-id": "invalid/turn",
        })])
        self.assertFalse((self.root / "report.json").exists())
        self.assertFalse((self.root / "provider-started").exists())

    def test_stop_and_notify_have_only_one_completion_writer(self):
        self.executable("codex", """
import json
with Path('provider-starts').open('a') as starts:
    starts.write('start\\n')
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'thread/goal/get':
        print(json.dumps({'id': request['id'], 'result': {'goal': None}}), flush=True)
""")
        # Already-running providers can retain the formerly installed Stop
        # hook. Refreshing its script must not create a second completion path.
        self.invoke({
            "hook_event_name": "Stop", "session_id": "conversation-complete",
            "turn_id": "turn-complete-1",
        })
        self.assertFalse((self.root / "provider-starts").exists())
        self.assertFalse((self.root / "report.json").exists())
        self.invoke(None, args=[json.dumps({
            "type": "agent-turn-complete", "thread-id": "conversation-complete",
            "turn-id": "turn-complete-1",
        })])
        self.assertEqual((self.root / "provider-starts").read_text().splitlines(), ['start'])
        reports = (self.root / "reports.jsonl").read_text().splitlines()
        self.assertEqual(len(reports), 1)
        report = json.loads(reports[0])["report"]
        self.assertTrue(report["turn_completed"])
        self.assertEqual(report["turn_completion_id"], "turn-complete-1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
