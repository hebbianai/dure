"""Exercise real Codex notifications against a loopback-only model fixture.

No credentials, real model request, live session, or installed hook is used.
Run: python3 scripts/qa/managed-codex-completion-path-smoke.py
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time


class ModelFixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size > 1024 * 1024 or not self.path.endswith("/responses"):
            self.send_error(400)
            return
        self.rfile.read(size)
        item = {
            "id": "msg_fixture", "type": "message", "role": "assistant",
            "status": "completed", "content": [{
                "type": "output_text", "text": "Fixture complete.", "annotations": [],
            }],
        }
        response = {
            "id": "resp_fixture", "object": "response", "created_at": 1,
            "status": "completed", "output": [item],
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
        }
        events = [
            {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
            {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
            {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "Fixture complete."},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": response},
        ]
        body = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    executable = shutil.which("codex")
    if executable is None:
        raise RuntimeError("Codex is required for this provider smoke")
    with tempfile.TemporaryDirectory(prefix="dure-codex-completion-") as directory:
        root = Path(directory)
        recorder = root / "record.py"
        recorder.write_text("""
import json, pathlib, sys
payload = json.loads(sys.argv[-1]) if len(sys.argv) > 1 else json.load(sys.stdin)
with (pathlib.Path(__file__).parent / 'events.jsonl').open('a') as events:
    events.write(json.dumps(payload) + '\\n')
""")
        environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": directory, "CODEX_HOME": directory, "CODEX_SQLITE_HOME": directory,
            "DURE_HOME": directory, "HMUX_DISCOVERY_ROOT": str(root / "discovery"),
        }
        server = ThreadingHTTPServer(("127.0.0.1", 0), ModelFixture)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        command = shlex.join([sys.executable, str(recorder)])
        hooks = [
            "-c", "features.hooks=true", "--dangerously-bypass-hook-trust",
            "-c", f"hooks.SessionStart=[{{hooks=[{{type=\"command\",command={json.dumps(command)},timeout=3}}]}}]",
            "-c", f"hooks.UserPromptSubmit=[{{hooks=[{{type=\"command\",command={json.dumps(command)},timeout=3}}]}}]",
            # Completion has one owner: notify. A Stop handler is unnecessary.
            "-c", "notify=" + json.dumps([sys.executable, str(recorder)]),
        ]
        args = [
            executable, "exec", "--json", "--skip-git-repo-check", "-C", directory,
            "-m", "gpt-5.6-sol", "-c", 'model_provider="fixture"',
            "-c", 'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:%d/v1",wire_api="responses",requires_openai_auth=false}' % server.server_port,
            *hooks, "Reply with the fixture response; do not call tools.",
        ]
        try:
            with subprocess.Popen(
                args, cwd=directory, env=environment, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
            ) as child:
                try:
                    stdout, stderr = child.communicate(timeout=30)
                    if child.returncode != 0:
                        raise RuntimeError(f"isolated Codex failed: {stderr.decode()[-2000:]}")
                    # notify is a separate child; observe its delivery before
                    # cleaning the fixture temporary files.
                    deadline = time.monotonic() + 5
                    events = []
                    while time.monotonic() < deadline:
                        event_file = root / "events.jsonl"
                        if event_file.exists():
                            events = [json.loads(line) for line in event_file.read_text().splitlines()]
                        if any(event.get("type") == "agent-turn-complete" for event in events):
                            break
                        time.sleep(0.02)
                    completed = [event for event in events if event.get("type") == "agent-turn-complete"]
                    if len(completed) != 1:
                        raise RuntimeError(f"expected one native completion; got events: {events}, output: {stdout.decode()[-1000:]}")
                    if not completed[0].get("turn-id") or not completed[0].get("thread-id"):
                        raise RuntimeError("completion lost the exact provider turn/thread identity")
                    print(json.dumps({"ok": True, "completionCount": len(completed), "stopHookInstalled": False,
                                      "nativeHookEvents": [event.get("hook_event_name") for event in events if "hook_event_name" in event]}))
                finally:
                    # Never signal a process group after its leader is reaped.
                    if child.poll() is None:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.communicate(timeout=5)
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join()


if __name__ == "__main__":
    main()
