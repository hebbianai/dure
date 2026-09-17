"""Real Codex Esc -> managed hook -> Hmux idle and preserve stop, without credentials.

Run through test:hmux-codex-interrupt with direct DURE_QA_HMUX_BIN/RUNTIME
executables. The guardian owns the disposable discovery root and Host cleanup.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time


class PendingModel(BaseHTTPRequestHandler):
    entered = threading.Event()
    release = threading.Event()

    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size > 1024 * 1024 or not self.path.endswith("/responses"):
            self.send_error(400)
            return
        self.rfile.read(size)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.flush()
        self.entered.set()
        self.release.wait(45)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hook-source", type=Path, default=Path(__file__).resolve().parents[2] / "src-tauri/resources/managed-claude-hook.py")
    args = parser.parse_args()
    root = Path(os.environ["DURE_HMUX_TEST_STATE_ROOT"]) / "codex-interrupt"
    root.mkdir(mode=0o700)
    cli = Path(os.environ.get("DURE_QA_HMUX_BIN", "hmux/target/debug/hmux")).resolve(strict=True)
    runtime = Path(os.environ.get("DURE_QA_HMUX_RUNTIME", "hmux/target/debug/hmux-runtime")).resolve(strict=True)
    codex = shutil.which(os.environ.get("DURE_QA_CODEX_BIN", "codex"))
    if not codex:
        raise RuntimeError("Codex is required for the interruption smoke")
    # Provider-managed plugin trees exceed the session guardian's census depth.
    # Retain this credential-free profile as evidence outside that boundary.
    profile = Path(tempfile.mkdtemp(prefix="dure-codex-interrupt-profile-", dir=root.parent.parent))
    print(json.dumps({"providerProfileEvidence": str(profile)}), flush=True)
    (profile / "config.toml").write_text(
        'check_for_update_on_startup=false\n'
        f'[projects.{json.dumps(str(root))}]\ntrust_level="trusted"\n'
    )
    environment = {
        "PATH": os.environ.get("PATH", os.defpath), "TERM": "xterm-256color",
        "HOME": str(root), "CODEX_HOME": str(profile), "CODEX_SQLITE_HOME": str(profile),
        "DURE_HOME": str(root), "HMUX_DISCOVERY_ROOT": os.environ["HMUX_DISCOVERY_ROOT"],
    }
    hook = root / "managed-codex-notify.sh"
    hook.write_text(args.hook_source.read_text().replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', json.dumps(str(runtime))))
    hook.chmod(0o700)
    bridge = Path(__file__).parent.resolve() / "fixtures/native-provider-input-bridge.py"
    server = ThreadingHTTPServer(("127.0.0.1", 0), PendingModel)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def command(arguments):
        result = subprocess.run(
            [str(cli), "--discovery-root", environment["HMUX_DISCOVERY_ROOT"], "--json", *arguments],
            cwd=root, env=environment, text=True, capture_output=True, timeout=10,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)

    def wait(predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(0.05)
        raise AssertionError("bounded fixture observation timed out")

    def broker(action, request):
        encoded = json.dumps(request).encode()
        result = subprocess.run(
            [str(runtime), "--no-autostart", action],
            input=len(encoded).to_bytes(4, "big") + encoded,
            capture_output=True, env=environment, cwd=root, timeout=20,
        )
        assert result.returncode == 0, result.stderr.decode()
        receipt = json.loads(result.stdout[4:])
        assert receipt["state"] == "completed", receipt
        return receipt

    def records():
        records = []
        for file in profile.glob("sessions/**/*.jsonl"):
            for line in file.read_text().splitlines():
                try:
                    record = json.loads(line)
                except ValueError:
                    continue  # The provider can be appending the final record.
                records.append(record)
        return records

    def events():
        return [record["payload"] for record in records() if record.get("type") == "event_msg"]

    created = False
    try:
        hook_args = ["--dangerously-bypass-hook-trust", "-c", "features.hooks=true"]
        for event in ("SessionStart", "UserPromptSubmit", "Interrupt"):
            hook_args.extend(["-c", f"hooks.{event}=[{{hooks=[{{type=\"command\",command={json.dumps(str(hook))},timeout=3}}]}}]"])
        request = {
            "schema": "hmux-managed-create-v1", "schemaVersion": 1,
            "idempotencyKey": "codex-interrupt-proof", "sessionId": "codex-interrupt-proof",
            "workspaceId": "codex-interrupt-workspace", "providerId": "codex",
            "permissionMode": "default", "providerCwd": str(root),
            "command": [sys.executable, str(bridge), codex, "--no-alt-screen",
                        "--sandbox", "workspace-write", "--ask-for-approval", "never",
                        "-m", "gpt-5.6-sol", "-c", 'model_provider="fixture"', "-c",
                        'model_providers.fixture={name="fixture",base_url="http://127.0.0.1:%d/v1",wire_api="responses",requires_openai_auth=false}' % server.server_port,
                        *hook_args, "Wait for the fixture response. Do not call tools."],
            "initialRows": 40, "initialColumns": 120,
        }
        broker("internal-hmux-managed-create", request)
        created = True
        session = command(["ls"])[0]
        fence = {key: session[key] for key in (
            "workspace_id", "session_id", "runner_principal", "runner_instance",
            "channel_epoch", "host_instance_id", "terminal_epoch",
        )}
        exact = ["--target", session["session_id"], "--workspace", session["workspace_id"]]
        wait(PendingModel.entered.is_set, 30)

        def state():
            return command(["session", "snapshot", session["session_id"], "--workspace", session["workspace_id"]])["agentRuntimeState"]

        before = state()
        assert before["activity"] == "working", before
        assert before["source"] == "provider_event", before
        started = time.monotonic()
        command(["send-keys", *exact, "--expected-fence-json", json.dumps(fence), "Escape"])
        wait(lambda: any(event.get("type") == "turn_aborted" for event in events()))
        after = wait(lambda: (current if (current := state())["activity"] == "waiting" else None), 5)
        assert after["source"] == "provider_event", after
        assert after["turn_completed_count"] == before["turn_completed_count"], (before, after)
        assert not any(event.get("type") == "task_complete" for event in events())
        interrupt_to_idle_ms = round((time.monotonic() - started) * 1000)
        conversation_ids = {record["payload"]["id"] for record in records() if record.get("type") == "session_meta"}
        assert len(conversation_ids) == 1, "the fixture must retain one exact conversation"
        # Activity alone is insufficient: the same source must admit the
        # conversation/quiescence-fenced stop used by credential switching.
        snapshot = command(["session", "snapshot", session["session_id"], "--workspace", session["workspace_id"]])
        stop = broker("internal-hmux-managed-stop", {
            "schema": "hmux-managed-stop-v1", "schemaVersion": 5,
            "stopId": "codex-interrupt-preserve-stop",
            "sessionId": session["session_id"], "workspaceId": session["workspace_id"],
            "expectedRunnerPrincipal": fence["runner_principal"],
            "expectedRunnerInstance": fence["runner_instance"],
            "expectedChannelEpoch": int(fence["channel_epoch"]),
            "expectedHostInstanceId": fence["host_instance_id"],
            "expectedTerminalEpoch": fence["terminal_epoch"],
            "expectedQuiescence": {
                "terminalEpoch": after["terminal_epoch"],
                "runtimeRevision": int(after["revision"]),
                "observedThroughOutputSeq": int(snapshot["sequenceThrough"]),
            },
            "expectedConversation": {"providerId": "codex", "conversationId": next(iter(conversation_ids))},
        })
        assert stop["payload"]["outcome"] == "stopped", stop
        created = False
        print(json.dumps({
            "ok": True, "provider": subprocess.check_output([codex, "--version"], text=True).strip(),
            "before": before, "after": after, "interruptToIdleMs": interrupt_to_idle_ms,
            "preserveStop": stop,
            "realCredentialsUsed": False, "modelRequests": "loopback-only",
        }))
    finally:
        PendingModel.release.set()
        if created:
            (root / "stop-provider").write_text("stop")
            wait(lambda: (root / "provider-exit.json").exists(), 5)
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
