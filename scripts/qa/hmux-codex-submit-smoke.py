"""Opt-in actual Codex acceptance proof, run under the Hmux test guardian.

Supply direct DURE_QA_HMUX_BIN/RUNTIME executables, DURE_QA_CODEX_BIN,
DURE_QA_CODEX_AUTH and an owner-only DURE_QA_EVIDENCE_DIRECTORY. Credentials
are copied only into this disposable provider profile. No live session is used.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

root = Path(os.environ["DURE_HMUX_TEST_STATE_ROOT"]) / "codex-submit"
root.mkdir(mode=0o700)
evidence_root = Path(os.environ["DURE_QA_EVIDENCE_DIRECTORY"]).resolve(strict=True)
assert evidence_root.stat().st_mode & 0o077 == 0
assert evidence_root.stat().st_uid == os.getuid()
# Provider plugin trees must stay outside the guardian's bounded session census.
profile = evidence_root / "provider-profile"
profile.mkdir(mode=0o700)
home = root / "home"
home.mkdir(mode=0o700)
try:
    shutil.copyfile(os.environ["DURE_QA_CODEX_AUTH"], profile / "auth.json")
    (profile / "auth.json").chmod(0o600)
    (profile / "config.toml").write_text(
        'model = "gpt-6-astra"\n[projects.' + json.dumps(str(root)) + ']\ntrust_level = "trusted"\n'
    )
    environment = dict(os.environ, HOME=str(home), CODEX_HOME=str(profile), TERM="xterm-256color",
                       DURE_HOME=str(root), DURE_APP_CHANNEL="stable", DURE_HMUX_BIN=os.environ["DURE_QA_HMUX_BIN"])
    for key in list(environment):
        if key.startswith(("DURE_ORCHESTRATION_", "DURE_BACKEND_", "HMUX_SESSION", "HMUX_WORKSPACE", "HMUX_RUNNER",
                           "HMUX_CHANNEL", "HMUX_HOST", "HMUX_TERMINAL", "CODEX_SESSION",
                           "CODEX_THREAD", "HEBBIAN_")) or key == "HMUX":
            environment.pop(key)
    cli = os.environ["DURE_QA_HMUX_BIN"]
    runtime = os.environ["DURE_QA_HMUX_RUNTIME"]
    codex = Path(os.environ["DURE_QA_CODEX_BIN"]).resolve(strict=True)
    bridge = Path(__file__).parent / "fixtures/native-provider-input-bridge.py"
    evidence = {
        "codexSha256": hashlib.sha256(codex.read_bytes()).hexdigest(),
        "clientSha256": hashlib.sha256(Path(cli).read_bytes()).hexdigest(),
        "runtimeSha256": hashlib.sha256(Path(runtime).read_bytes()).hexdigest(),
        "harnessSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "bridgeSha256": hashlib.sha256(bridge.read_bytes()).hexdigest(),
        "cases": [],
    }


    def command(arguments):
        result = subprocess.run(
            [cli, "--discovery-root", environment["HMUX_DISCOVERY_ROOT"], "--json", *arguments],
            cwd=root, env=environment, text=True, capture_output=True, timeout=20,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)


    def records():
        result = []
        for file in profile.glob("sessions/**/*.jsonl"):
            for line in file.read_text().splitlines():
                try:
                    result.append(json.loads(line))
                except ValueError:
                    pass  # The provider may still be writing the last record.
        return result


    def user_texts():
        return ["".join(part.get("text", "") for part in record["payload"]["content"]
                        if part.get("type") == "input_text")
                for record in records()
                if record.get("type") == "response_item" and record.get("payload", {}).get("role") == "user"]


    def completions():
        return [record for record in records() if record.get("type") == "event_msg"
                and record.get("payload", {}).get("type") == "task_complete"]


    def wait(predicate, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)  # Poll provider-owned records, never pace input writes.
        return False


    session = None
    try:
        request = {
            "schema": "hmux-managed-create-v1", "schemaVersion": 1,
            "idempotencyKey": "native-submit-proof", "sessionId": "native-submit-proof",
            "workspaceId": "native-submit-proof-workspace", "providerId": "codex",
            "permissionMode": "default", "providerCwd": str(root),
            "command": ["python3", str(bridge), str(codex), "--no-alt-screen", "--sandbox",
                        "workspace-write", "--ask-for-approval", "never", "Reply READY. Do not use any tools."],
            "initialRows": 40, "initialColumns": 120,
        }
        encoded = json.dumps(request).encode()
        created = subprocess.run([runtime, "--no-autostart", "internal-hmux-managed-create"],
                                 input=len(encoded).to_bytes(4, "big") + encoded,
                                 capture_output=True, env=environment, cwd=root, timeout=20)
        assert created.returncode == 0, created.stderr.decode()
        assert int.from_bytes(created.stdout[:4], "big") == len(created.stdout) - 4
        create_receipt = json.loads(created.stdout[4:])
        assert create_receipt["state"] == "completed", create_receipt
        evidence["createReceipt"] = create_receipt
        sessions = command(["ls"])
        assert len(sessions) == 1
        session = sessions[0]
        evidence["session"] = session
        assert session["session_class"] == "managed"
        fence = {key: session[key] for key in ("workspace_id", "session_id", "runner_principal",
                                             "runner_instance", "channel_epoch", "host_instance_id", "terminal_epoch")}
        binding = {"schemaVersion": 1, "runtime": "hmux_managed_v1", "source": "local", "hostId": "local",
                   "sessionId": session["session_id"], "workspaceId": session["workspace_id"],
                   "stopFence": {"runnerPrincipal": fence["runner_principal"],
                                 "runnerInstance": fence["runner_instance"], "channelEpoch": fence["channel_epoch"],
                                 "hostInstanceId": fence["host_instance_id"], "terminalEpoch": fence["terminal_epoch"]}}
        (root / "agents.json").write_text(json.dumps({"version": 4, "agents": [{
            "id": "native-submit-agent", "name": "native-submit", "project": "QA", "provider": "codex",
            "sessionId": session["session_id"], "runtimeBinding": binding}]}))
        assert wait(lambda: len(completions()) == 1, 60), "initial provider completion missing"
        child = json.loads((root / "provider-child.json").read_text())
        child["processObservation"] = subprocess.check_output(
            ["ps", "-p", str(child["pid"]), "-o", "pid=,ppid=,lstart=,command="], text=True).strip()
        assert str(codex) in child["processObservation"]
        evidence["providerChild"] = child
        initial_users = len(user_texts())
        evidence["initialUserCount"] = initial_users
        exact = ["--target", session["session_id"], "--workspace", session["workspace_id"]]

        def send(text, submit=True):
            (root / "hold-input").write_text("hold")
            (root / "input.txt").write_text(text)
            dure_cli = Path(__file__).resolve().parents[2] / "cli/dure.mjs"
            delivered = subprocess.run(["node", str(dure_cli), "send", "native-submit", "--file",
                                        str(root / "input.txt"), "--json", *([] if submit else ["--no-enter"])],
                                       cwd=root, env=environment, text=True, capture_output=True, timeout=20)
            assert delivered.returncode == 0, delivered.stdout + delivered.stderr
            receipt = json.loads(delivered.stdout)
            assert receipt["target"]["sessionId"] == session["session_id"]
            # Coalesce the acknowledged bytes before the actual provider sees them.
            (root / "release-input").write_text("release")
            assert wait(lambda: not (root / "hold-input").exists()), "input bridge did not release"
            evidence["cases"].append({"input": text, "submit": submit, "receipt": receipt})
            return receipt

        def accepted_once(text):
            accepted = wait(lambda: text.strip() in user_texts())
            evidence["cases"][-1]["acceptedCount"] = user_texts().count(text.strip())
            assert accepted, "written_to_pty but actual Codex accepted no matching user input"
            assert user_texts().count(text.strip()) == 1, "provider accepted duplicate input"

        short = "Reply RECEIVED. Do not use any tools. " + (
            "Review bounded work assignments independently and preserve existing changes. " * 4)
        send(short)
        accepted_once(short)
        assert wait(lambda: len(completions()) == 2)
        long = "Reply MULTILINGUAL. Do not use any tools.\n" + (
            "Long multiline assignment. 한국어 입력도 한 번만 제출합니다.\n" * 100)
        send(long)
        accepted_once(long)
        assert wait(lambda: len(completions()) == 3)

        os.mkfifo(root / "continue-busy")
        (root / "busy.py").write_text(
            'from pathlib import Path\nPath("busy-ready").write_text("ready")\n'
            'with open("continue-busy") as release: release.readline()\nprint("RELEASED")\n'
        )
        busy = "Run python3 busy.py in the current directory. Wait for it to return, then reply RELEASED."
        send(busy)
        accepted_once(busy)
        assert wait(lambda: (root / "busy-ready").exists()), "provider did not start the blocking fixture"
        complete_before = len(completions())
        steer = "After the current command returns, include BUSY_INPUT in your reply. 바쁜 상태의 입력입니다."
        send(steer)
        # Enter keeps the provider's own busy-input policy. Acceptance is checked
        # after the blocking command returns, without relabelling its PTY receipt.
        queue = "Reply QUEUED_INPUT after the current task. 명시적으로 대기열에 넣은 입력입니다."
        send(queue, submit=False)
        evidence["queueKeyReceipt"] = command([
            "send-keys", *exact, "--expected-fence-json", json.dumps(fence), "Tab"])
        assert queue not in user_texts(), "queued input was already a submitted user record"
        assert len(completions()) == complete_before, "blocking fixture completed before release"
        evidence["queueInputBeforeRelease"] = {"acceptedCount": user_texts().count(queue),
                                                "completedTaskCount": len(completions())}
        with open(root / "continue-busy", "w") as release:
            release.write("release\n")
        assert wait(lambda: steer in user_texts()), "busy Enter input was never accepted"
        assert wait(lambda: queue in user_texts()), "queued input was never accepted after release"
        assert user_texts().count(steer) == user_texts().count(queue) == 1
        assert len(user_texts()) == initial_users + 5, "unexpected extra provider user messages"
        stale = dict(fence, terminal_epoch="replaced-terminal-epoch")
        refused = subprocess.run([cli, "--discovery-root", environment["HMUX_DISCOVERY_ROOT"], "--json",
                                  "command-input", *exact, "--expected-fence-json", json.dumps(stale),
                                  "--text", "STALE_MUST_NOT_WRITE", "--submit"],
                                 cwd=root, env=environment, text=True, capture_output=True, timeout=10)
        assert refused.returncode != 0, "stale attachment unexpectedly admitted input"
        evidence["staleAttachmentRefusal"] = {"exitCode": refused.returncode,
                                            "stdout": refused.stdout, "stderr": refused.stderr}
        # Catalog refusal happens before attach; this CLI version renders its
        # message on stderr before entering the command-input JSON delivery path.
        assert refused.stdout == ""
        assert refused.stderr.strip() == (
            "hmux: error: expected fence names neither the current generation nor its exact durable rehost source"
        ), refused.stderr
        assert "STALE_MUST_NOT_WRITE" not in user_texts()
        evidence["busyAcceptedCount"] = user_texts().count(steer)
        evidence["queuedAcceptedCount"] = user_texts().count(queue)
        evidence["behaviorPassed"] = True
    finally:
        evidence["users"] = user_texts()
        evidence["completionRecords"] = completions()
        (evidence_root / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
        if session:
            (root / "stop-provider").write_text("stop")
            assert wait(lambda: (root / "provider-exit.json").exists(), 5), "actual provider child exit missing"
            evidence["providerChildExit"] = json.loads((root / "provider-exit.json").read_text())
            child = json.loads((root / "provider-child.json").read_text())
            assert evidence["providerChildExit"]["waitedPid"] == child["pid"]
            evidence["cleanup"] = "Native child reaped; outer Host retirement is verified by the test guardian"
            evidence["providerSources"] = [{"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
                                           for file in profile.glob("sessions/**/*.jsonl")]
            for case in evidence["cases"]:
                case["acceptedCount"] = user_texts().count(case["input"].strip())
            (evidence_root / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
        evidence["passed"] = evidence.get("behaviorPassed", False)
        (evidence_root / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
        print(json.dumps({"passed": evidence.get("passed", False), "cases": len(evidence["cases"]),
                          "evidence": str(evidence_root / "evidence.json")}))
finally:
    (profile / "auth.json").unlink(missing_ok=True)
