"""Exercise hook root selection with a disposable home and HTTP report fixture.

Run with: python3 scripts/qa/managed-provider-hook-root-test.py
No provider, native runtime, or live credentials are used.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import threading
import time
import unittest


HOOK = Path(__file__).resolve().parents[2] / "src-tauri/resources/managed-claude-hook.py"


class HookRootTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dure-hook-root-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.legacy = self.home / ".hebbian"
        self.canonical = self.home / ".dure"
        self.reports = []
        self.sequences = []
        self.environment = {
            "PATH": os.defpath,
            "HOME": str(self.home),
            "HMUX_DISCOVERY_ROOT": str(self.home / "discovery"),
            "HMUX_SESSION_ID": "fixture-session",
            "HMUX_WORKSPACE_ID": "fixture-workspace",
            "HMUX_RUNNER_PRINCIPAL": "fixture-user",
            "HMUX_RUNNER_INSTANCE": "fixture-runner",
            "HMUX_CHANNEL_EPOCH": "7",
            "HMUX_HOST_INSTANCE_ID": "fixture-host",
            "HMUX_TERMINAL_EPOCH": "fixture-terminal",
        }

    def descriptor(self, root, generation, capability="managed_claude_host_report_causality_v1"):
        reports = self.reports
        sequences = self.sequences
        descriptor = {
            "channel": "stable", "generation": generation,
            "processId": 1001, "reportToken": "fixture-token",
        }

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, body):
                if self.headers.get("Authorization") != "Bearer fixture-token":
                    self.send_response(401)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def do_GET(self):
                self.reply({
                    **descriptor, "ok": True,
                    "capabilities": [capability],
                })

            def do_POST(self):
                sequences.append(int(self.headers["X-Hebbian-Hmux-Source-Sequence"]))
                reports.append((generation, self.path, json.loads(
                    self.rfile.read(int(self.headers["Content-Length"])),
                )))
                self.reply({"ok": True})

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            thread.join()
            server.server_close()

        self.addCleanup(stop)
        descriptor["port"] = server.server_port
        root.mkdir(mode=0o700, exist_ok=True)
        target = root / "server.json"
        target.write_text(json.dumps(descriptor))
        target.chmod(0o600)

    def invoke(self, event="PreToolUse"):
        payload = {"hook_event_name": event, "session_id": "fixture-conversation"}
        result = subprocess.run(
            [sys.executable, str(HOOK), "claude", "--managed-direct"],
            cwd=self.home, env=self.environment, input=json.dumps(payload),
            text=True, capture_output=True, timeout=5,
        )
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def assert_reports(self, generation, events):
        self.assertEqual(self.reports, [
            (generation, "/hooks/claude", {
                "hook_event_name": event, "session_id": "fixture-conversation",
            }) for event in events
        ])

    def test_legacy_fallback_reports_repeatedly_without_mutating_legacy(self):
        self.descriptor(self.legacy, "legacy")
        before = (self.legacy / "server.json").read_bytes()
        self.invoke()
        self.invoke()
        self.assertEqual(sorted(p.name for p in self.legacy.iterdir()), ["server.json"])
        self.assertEqual((self.legacy / "server.json").read_bytes(), before)
        self.assertFalse(self.canonical.exists())
        self.assert_reports("legacy", ["PreToolUse", "PreToolUse"])

    def test_unsafe_canonical_entry_does_not_redirect_writes_into_legacy(self):
        self.canonical.write_text("unsafe canonical entry")
        self.descriptor(self.legacy, "legacy")
        self.invoke()
        self.assertFalse((self.legacy / "hook-throttle").exists())
        self.assertEqual(self.canonical.read_text(), "unsafe canonical entry")
        self.assert_reports("legacy", ["PreToolUse"])

    def test_canonical_root_wins_and_coalesces_only_pre_tool_use(self):
        self.descriptor(self.legacy, "legacy")
        self.descriptor(self.canonical, "canonical")
        self.invoke()
        self.invoke()
        self.invoke("Stop")
        self.assertTrue((self.canonical / "hook-throttle/pretooluse-fixture-session.stamp").is_file())
        self.assertFalse((self.legacy / "hook-throttle").exists())
        self.assert_reports("canonical", ["PreToolUse", "Stop"])

    def test_explicit_root_retains_coalescing(self):
        explicit = self.home / "explicit"
        self.descriptor(explicit, "explicit")
        self.environment["DURE_HOME"] = str(explicit)
        self.invoke()
        self.invoke()
        self.assertTrue((explicit / "hook-throttle/pretooluse-fixture-session.stamp").is_file())
        self.assertFalse(self.canonical.exists())
        self.assert_reports("explicit", ["PreToolUse"])

    def test_fresh_home_writes_only_canonical_state(self):
        self.invoke()
        self.assertTrue((self.canonical / "hook-throttle/pretooluse-fixture-session.stamp").is_file())
        self.assertFalse(self.legacy.exists())

    def test_old_app_cannot_silently_discard_causality(self):
        self.descriptor(self.canonical, "old", "managed_claude_host_report_v1")
        self.invoke("UserPromptSubmit")
        self.assertEqual(self.reports, [])

    def test_source_sequence_is_captured_before_stdin_and_preserved_in_transport(self):
        self.descriptor(self.canonical, "current")
        before = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
        process = subprocess.Popen(
            [sys.executable, "-c", (
                "import runpy,sys; sys.argv=sys.argv[1:]; "
                "hook=runpy.run_path(sys.argv[0]); "
                "print('ready',flush=True); hook['main']()"
            ), str(HOOK), "claude", "--managed-direct"],
            cwd=self.home, env=self.environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        # The harness acknowledges source capture before supplying stdin. No
        # scheduler-speed assumption or production delay is needed.
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(timeout=5), "Hook import did not finish")
                self.assertEqual(process.stdout.readline(), "ready\n")
            supplied = time.clock_gettime_ns(time.CLOCK_MONOTONIC)
            output = process.communicate(json.dumps({
                "hook_event_name": "UserPromptSubmit", "session_id": "fixture-conversation",
            }), timeout=5)
        finally:
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=5)
        self.assertEqual((process.returncode, *output), (0, "", ""))
        self.assertEqual(len(self.sequences), 1)
        self.assertLessEqual(before, self.sequences[0])
        self.assertLess(self.sequences[0], supplied)


if __name__ == "__main__":
    unittest.main()
