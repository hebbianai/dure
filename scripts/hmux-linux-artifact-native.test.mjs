import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { requiresHmuxArtifact } from "./lib/hmux-artifact-impact.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const read = (relativePath) =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");

const driver = read("scripts/qa/hmux-linux-artifact-lima.sh");
const probe = read("scripts/qa/hmux-linux-artifact-probe.py");
const lima = read("scripts/qa/hmux-linux-artifact-lima.yaml");
const exactCleanupPath = path.join(
  repositoryRoot,
  "scripts/qa/hmux-linux-artifact-exact-cleanup.py",
);
const probePath = path.join(
  repositoryRoot,
  "scripts/qa/hmux-linux-artifact-probe.py",
);

const runProbeUnit = (source) =>
  spawnSync("python3", ["-c", source, probePath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    encoding: "utf8",
  });

const executable = (file, contents) => {
  fs.writeFileSync(file, contents, { mode: 0o755 });
};

const partialStartFixture = ({ stickyDelete = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hmux-two-vm-cleanup-"));
  const bin = path.join(root, "bin");
  const stage = path.join(root, "stage");
  const evidence = path.join(root, "evidence");
  const calls = path.join(root, "calls");
  const state = path.join(root, "lima-state");
  fs.mkdirSync(bin);
  fs.mkdirSync(stage);
  const archiveName = "fixture.tar.gz";
  const archive = Buffer.from("fixture archive");
  fs.writeFileSync(path.join(stage, archiveName), archive);
  fs.writeFileSync(
    path.join(stage, "SHA256SUMS"),
    `${createHash("sha256").update(archive).digest("hex")}  ${archiveName}\n`,
  );
  executable(
    path.join(bin, "uname"),
    `#!/bin/sh
case "\${1:-}" in
  -s) printf '%s\\n' Darwin ;;
  -m) printf '%s\\n' arm64 ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "limactl"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FAKE_LIMA_CALLS"
case "\${1:-}" in
  --version)
    printf '%s\\n' 'limactl version 1.2.1'
    ;;
  start)
    instance=
    expect_name=0
    for argument in "$@"; do
      if [ "$expect_name" -eq 1 ]; then
        instance=$argument
        expect_name=0
        continue
      fi
      case "$argument" in
        --name) expect_name=1 ;;
        --name=*) instance=\${argument#--name=} ;;
      esac
    done
    [ -n "$instance" ] || exit 90
    printf '%s\\n' "$instance" >>"$FAKE_LIMA_STATE"
    case "$instance" in
      *-client) exit 42 ;;
    esac
    ;;
  stop)
    ;;
  delete)
    instance=
    for argument in "$@"; do
      case "$argument" in
        --*) ;;
        *) instance=$argument ;;
      esac
    done
    if [ "\${FAKE_LIMA_STICKY_DELETE:-0}" != 1 ]; then
      grep -Fxv "$instance" "$FAKE_LIMA_STATE" >"$FAKE_LIMA_STATE.tmp" || true
      mv "$FAKE_LIMA_STATE.tmp" "$FAKE_LIMA_STATE"
    fi
    ;;
  list)
    [ -f "$FAKE_LIMA_STATE" ] && cat "$FAKE_LIMA_STATE"
    ;;
  *)
    exit 91
    ;;
esac
`,
  );
  const result = spawnSync(
    "sh",
    [
      path.join(repositoryRoot, "scripts/qa/hmux-linux-artifact-lima.sh"),
      stage,
      evidence,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        // This fixture intentionally exercises the driver's non-GitHub naming
        // fallback. Self-hosted CI exports these globally, so clear them
        // explicitly instead of letting the runner rewrite the expectation.
        GITHUB_RUN_ID: "",
        GITHUB_RUN_ATTEMPT: "",
        FAKE_LIMA_CALLS: calls,
        FAKE_LIMA_STATE: state,
        FAKE_LIMA_STICKY_DELETE: stickyDelete ? "1" : "0",
        HMUX_EXPECTED_SOURCE_COMMIT: "0".repeat(40),
        HMUX_LINUX_ARTIFACT_REMOTE_CARRIER: "1",
      },
      encoding: "utf8",
    },
  );
  return {
    calls: fs.readFileSync(calls, "utf8").trim().split("\n"),
    evidence,
    result,
    root,
    state,
  };
};

describe("native Linux artifact execution contract", () => {
  test("pins the Linux image, Lima version, and bounded VM resources", () => {
    expect(lima).toContain("minimumLimaVersion: 1.2.1");
    expect(lima).toContain("release-20260725");
    expect(lima).toContain(
      "sha256:2eaec7286c49fdea713dddabcf5012cafa7097a658e916acb48f4bc5fdc8e419",
    );
    expect(lima.match(/location:/g)).toHaveLength(1);
    expect(lima).toContain("cpus: 4");
    expect(lima).toContain("memory: 4GiB");
    expect(lima).toContain("disk: 20GiB");
    expect(lima).toContain("enabled: true");
    expect(lima).toContain("binfmt: true");
    expect(lima).toContain("mounts: []");
    expect(driver).toContain('lima_version=1.2.1');
    expect(driver).toContain(
      'if [ "$(lima --version)" != "limactl version $lima_version" ]',
    );
    expect(driver).toContain('lima_with_timeout 120 "$@"');
    expect(driver).toContain("bounded_command 630 limactl start");
    expect(driver).toContain("bounded_command 45 limactl");
    expect(driver).toContain(
      "phase_lima_timeout_seconds=$((minimum_soak_seconds + 120))",
    );
    expect(driver).toContain(
      'lima_with_timeout "$phase_lima_timeout_seconds"',
    );

  });

  test("runs both uploaded archive shapes rather than an installed CLI", () => {
    for (const triple of [
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
    ]) {
      expect(driver).toContain(triple);
    }
    expect(driver).toContain('-name "*.$triple.release.tar.gz"');
    expect(driver).toContain(
      'lima copy "$archive" "$vm_name:$guest_archive"',
    );
    expect(driver).toContain(
      'lima shell --tty=false "$vm_name" tar -xzf',
    );
    expect(driver).toContain(
      'lima copy "$archive" "$client_vm_name:$guest_archive"',
    );
    expect(driver).not.toContain("$HOME/.local/bin/hmux");
    expect(probe).toContain('"buildId": context.build_id');
    expect(probe).toContain('"sourceCommit": context.expected_source');
    expect(probe).toContain('"targetTriple": context.triple');
  });

  test("rejects a feature-dark runtime before the native attach", () => {
    const result = runProbeUnit(String.raw`
import importlib.util
import json
import pathlib
import subprocess
import sys

spec = importlib.util.spec_from_file_location("artifact_probe", sys.argv[1])
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class FakeContext:
    build_id = "build-1"
    expected_source = "1" * 40
    triple = "x86_64-unknown-linux-musl"
    runtime = pathlib.Path("/fixture/hmux-runtime")
    hmux = pathlib.Path("/fixture/hmux")

    def environment(self):
        return {}

def fake_run(command, **_kwargs):
    if command[-1] == "hmux-build-info":
        payload = runtime_payload
    else:
        payload = {"buildInfo": {"buildId": FakeContext.build_id}}
    return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")

runtime_payload = {
    "buildId": FakeContext.build_id,
    "sourceCommit": FakeContext.expected_source,
    "targetTriple": FakeContext.triple,
}
probe.run = fake_run
try:
    probe.runtime_identity(FakeContext())
except probe.ProbeFailure as error:
    assert "product profile" in str(error)
else:
    raise AssertionError("feature-dark runtime was accepted by the native probe")

runtime_payload["productProfile"] = "structured-terminal-v1"
assert probe.runtime_identity(FakeContext()) == runtime_payload
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("validates the exact structured HelloAck and initial TSPB viewport", () => {
    const result = runProbeUnit(String.raw`
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("artifact_probe", sys.argv[1])
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

state = {"fence": {"session_id": "session-1", "terminal_epoch": "epoch-1"}}
hello = probe.structured_hello_payload(state)
assert hello["requested_mode"] == "observer"
assert hello["requested_capabilities"] == [
    *probe.STRUCTURED_BASE_CAPABILITIES,
    *probe.STRUCTURED_TERMINAL_CAPABILITIES,
]
ack = {
    "selected_version": {"major": 1, "minor": 0},
    "selected_capabilities": list(reversed(probe.STRUCTURED_TERMINAL_CAPABILITIES)),
    "actual_fence": state["fence"],
}
assert probe.validate_structured_ack(ack, state) == sorted(
    probe.STRUCTURED_TERMINAL_CAPABILITIES
)

def expect_probe_failure(call, text):
    try:
        call()
    except probe.ProbeFailure as error:
        assert text in str(error), str(error)
    else:
        raise AssertionError(f"invalid structured record was accepted: {text}")

missing = dict(ack)
missing["selected_capabilities"] = list(probe.STRUCTURED_TERMINAL_CAPABILITIES[:-1])
expect_probe_failure(
    lambda: probe.validate_structured_ack(missing, state),
    "exactly the product profile",
)
parallel_legacy = dict(ack)
parallel_legacy["selected_capabilities"] = [
    *probe.STRUCTURED_TERMINAL_CAPABILITIES,
    "screen_snapshot",
]
expect_probe_failure(
    lambda: probe.validate_structured_ack(parallel_legacy, state),
    "exactly the product profile",
)
duplicate = dict(ack)
duplicate["selected_capabilities"] = [
    *probe.STRUCTURED_TERMINAL_CAPABILITIES,
    probe.STRUCTURED_TERMINAL_CAPABILITIES[0],
]
expect_probe_failure(
    lambda: probe.validate_structured_ack(duplicate, state),
    "malformed capabilities",
)

def envelope(kind, record_id=7, reserved=0, major=1, minor=None):
    body = b"viewport"
    if minor is None:
        minor = 4 if kind == 8 else 5
    return (
        b"TSPB"
        + bytes((major, minor, kind, reserved))
        + len(body).to_bytes(4, "little")
        + record_id.to_bytes(8, "little")
        + body
    )

assert probe.validate_structured_envelope(envelope(8)) == (8, 7)
assert probe.validate_structured_envelope(envelope(12, record_id=9)) == (12, 9)
viewport = envelope(8)
wire = (
    probe.encode_frame("hello_ack", ack)
    + len(viewport).to_bytes(4, "big")
    + viewport
)
read_descriptor, write_descriptor = os.pipe()
with os.fdopen(write_descriptor, "wb", buffering=0) as writer:
    writer.write(wire)
with os.fdopen(read_descriptor, "rb", buffering=0) as stream:
    assert probe.read_structured_attach_seed(
        probe.FramedReader(stream), state
    ) == (sorted(probe.STRUCTURED_TERMINAL_CAPABILITIES), 8, 7)
expect_probe_failure(
    lambda: probe.validate_structured_envelope(envelope(8, major=2)),
    "another terminal envelope major",
)
expect_probe_failure(
    lambda: probe.validate_structured_envelope(envelope(8, reserved=1)),
    "nonzero terminal envelope flags",
)
for kind, minor in ((8, 5), (8, 255), (12, 4)):
    expect_probe_failure(
        lambda kind=kind, minor=minor: probe.validate_structured_envelope(
            envelope(kind, minor=minor)
        ),
        "terminal envelope minor",
    )
expect_probe_failure(
    lambda: probe.validate_structured_envelope(envelope(8, record_id=0)),
    "zero terminal record id",
)
expect_probe_failure(
    lambda: probe.validate_structured_envelope(envelope(4)),
    "no initial viewport record",
)
bad_length = bytearray(envelope(8))
bad_length[8:12] = (99).to_bytes(4, "little")
expect_probe_failure(
    lambda: probe.validate_structured_envelope(bytes(bad_length)),
    "mismatched terminal payload length",
)
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("runs the structured product proof before the legacy reconnect soak", () => {
    const prepare = driver.indexOf('run_phase prepare "$triple"');
    const structured = driver.indexOf(
      'run_phase structured-attach "$triple"',
    );
    const resume = driver.indexOf('run_phase resume "$triple"');
    expect(prepare).toBeGreaterThan(0);
    expect(structured).toBeGreaterThan(prepare);
    expect(resume).toBeGreaterThan(structured);
    expect(probe).toContain('"productProfile": runtime["productProfile"]');
    expect(probe).toContain('"selectedStructuredCapabilities": selected');
    expect(probe).toContain('"initialStructuredViewport": True');
    expect(probe).toContain('int.from_bytes(payload[8:12], "little")');
    expect(probe).toContain('int.from_bytes(payload[12:20], "little")');
    expect(driver).toContain(
      'triple, "structured-attach", "structured_attach", build_id',
    );
    expect(driver).toContain('"structuredTerminal": structured_observations');
  });

  test("disconnects the SSH carrier between create and reattach", () => {
    const prepare = driver.indexOf('run_phase prepare "$triple"');
    const resume = driver.indexOf('run_phase resume "$triple"');
    expect(prepare).toBeGreaterThan(0);
    expect(resume).toBeGreaterThan(prepare);
    expect(probe).toContain('"carrierReconnected": True');
    expect(probe).toContain('"observerDetached": True');
    expect(probe).toContain('"realSshdForcedCommand": True');
    expect(probe).toContain('"cursorResumeWithoutSnapshot": True');
    expect(probe).toContain('"reconnect_cursor": reconnect_cursor');
    expect(probe).toContain('f"{user}@{host}"');
    expect(probe).toContain("port=int(paired_host[\"port\"])");
    expect(probe).toContain(
      'raise ProbeFailure("cursor reconnect redownloaded a snapshot")',
    );
    expect(probe).toContain("owned session generation changed");
    expect(probe).toContain("--expected-fence-json");
  });

  test("uses distinct scheduled endpoints for a non-loopback SSH resume", () => {
    const clientPrepare = driver.indexOf(
      'run_client_phase remote-client-prepare "$triple"',
    );
    const authorize = driver.indexOf('run_phase authorize-remote "$triple"');
    const open = driver.indexOf('run_client_phase remote-open "$triple"');
    const marker = driver.indexOf('run_phase remote-marker "$triple"');
    const resume = driver.indexOf('run_client_phase remote-resume "$triple"');
    const revoke = driver.indexOf('run_phase revoke-remote "$triple"');
    const rejected = driver.indexOf(
      'run_client_phase remote-rejected "$triple"',
    );
    expect(driver).toContain("--network=lima:user-v2");
    expect(driver).toContain('client_vm_name="$vm_name-client"');
    expect(driver).toContain('remote_host="lima-$vm_name.internal"');
    expect(driver).toContain(
      'if [ "$client_boot_id" = "$server_boot_id" ]; then',
    );
    expect(driver).toContain(
      'run_phase remote-disconnected-soak "$triple"',
    );
    expect(probe).toContain('"carrierState": "client_ssh_process_terminated"');
    expect(probe).toContain('"remoteCarrierDisconnectedMsObserved"');
    expect(clientPrepare).toBeGreaterThan(0);
    expect(authorize).toBeGreaterThan(clientPrepare);
    expect(open).toBeGreaterThan(authorize);
    expect(marker).toBeGreaterThan(open);
    expect(resume).toBeGreaterThan(marker);
    expect(revoke).toBeGreaterThan(resume);
    expect(rejected).toBeGreaterThan(revoke);
    expect(probe).toContain('"topology": "two_vm_user_v2"');
    expect(probe).toContain('"carrierDroppedWithoutDetach": True');
    expect(probe).toContain(
      '"authorizedKeysBytesOwnerModeRestored": True',
    );
    expect(probe).toContain('"revokedCredentialRejected": True');
    expect(probe).toContain(
      'raise ProbeFailure("remote cursor reconnect redownloaded a snapshot")',
    );
    expect(probe).toContain(
      'raise ProbeFailure("remote resume output sequence was not contiguous")',
    );
    expect(probe).toContain(
      'raise ProbeFailure("remote resume delta changed terminal epoch")',
    );
    expect(probe).toContain(
      'raise ProbeFailure("remote snapshot predates its HelloAck")',
    );
    expect(probe).toContain(
      "network host key did not match the server control plane",
    );
    expect(probe).toContain(
      "remote endpoint omitted an observer capability",
    );
    expect(probe).toContain(
      "remote endpoint granted an unrequested capability",
    );
    expect(probe).toContain('"sameSshdReachableAfterRevocation": True');
  });

  test("journals key rollback and transfers only a digest-bound handoff", () => {
    const authorize = probe.slice(
      probe.indexOf("def authorize_remote_client("),
      probe.indexOf("def remote_handoff("),
    );
    const prepared = authorize.indexOf('"state": "prepared"');
    const journalSave = authorize.indexOf("context.save_state(state)", prepared);
    const keyReplace = authorize.indexOf(
      "atomic_replace_bytes(\n        authorized_keys,",
    );
    const applied = authorize.indexOf(
      'state["remoteAuthorization"]["state"] = "applied"',
    );
    const injectedFault = authorize.indexOf("if fault_after_install:");
    expect(prepared).toBeGreaterThan(0);
    expect(journalSave).toBeGreaterThan(prepared);
    expect(keyReplace).toBeGreaterThan(journalSave);
    expect(injectedFault).toBeGreaterThan(keyReplace);
    expect(applied).toBeGreaterThan(injectedFault);
    expect(driver).toContain('run_phase remote-handoff "$triple"');
    expect(driver).toContain('transfer_remote_handoff "$triple"');
    expect(driver).toContain(
      'run_client_phase remote-state-import "$triple"',
    );
    expect(driver).toContain('run_phase failure-cleanup "$failed_triple"');
    expect(driver).toContain(
      "HMUX_LINUX_ARTIFACT_FAULT_AFTER_AUTHORIZATION",
    );
    expect(driver).toContain("--fault-after-authorization-install");
    expect(probe).toContain(
      "injected failure after authorization install and before applied marker",
    );
    expect(probe).toContain("return 86");
    expect(probe).toContain('"rollbackJournalPersistedBeforeInstall": True');
    expect(probe).toContain(
      "remote authorized_keys bytes were restored with different metadata",
    );
    expect(probe).toContain(
      "owned remote authorization entry was not removed",
    );
    expect(probe).toContain('"atomicImport": True');
    expect(probe).toContain(
      'set(document) != {\n        "schemaVersion",',
    );
    expect(driver).not.toContain(
      'cat "$guest_root/state-$triple/probe-state.json"',
    );
  });

  test("derives scheduled evidence from phase receipts", () => {
    expect(driver).toContain(
      'triple, "remote-open", "remote_open", build_id',
    );
    expect(driver).toContain(
      '"remote-disconnected-soak",\n            "remote_disconnected_soak"',
    );
    expect(driver).toContain(
      'rejected.get("sameSshdReachableAfterRevocation") is not True',
    );
    expect(driver).toContain(
      '"carrierDisconnectedMsObserved": observed_millis',
    );
    expect(driver).toContain(
      'imported.get("atomicImport") is not True',
    );
    expect(driver).toContain(
      'revoked.get("ownedEntryRemoved") is not True',
    );
    expect(driver).toContain(
      'revoked.get("authorizedKeysBytesOwnerModeRestored") is not True',
    );
    expect(driver).toContain(
      'client_prepare.get("hostKeyFingerprint", "")',
    );
    expect(driver).toContain(
      'authorize.get("forcedCommandInstalled") is not True',
    );
    expect(driver).toContain(
      'cleanup.get("generationFenced") is not True',
    );
    expect(driver).not.toContain('sleep "$minimum_soak_seconds"');
    const finalCleanup = driver.lastIndexOf("cleanup_vms");
    const summary = driver.indexOf('>"$evidence_directory/summary.json"');
    const success = driver.lastIndexOf(
      "write_run_receipt succeeded 0 0 1",
    );
    expect(finalCleanup).toBeLessThan(summary);
    expect(summary).toBeLessThan(success);
  });

  test("waits through partial prepare publication and rejects ambiguous loss", () => {
    const result = runProbeUnit(String.raw`
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location("artifact_probe", sys.argv[1])
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

ready = {
    "session_name": "owned",
    "session_id": "session-1",
    "lifecycle": "ready",
}

class FakeContext:
    def __init__(self, observations):
        self.observations = list(observations)
        self.calls = 0

    def list_sessions(self):
        self.calls += 1
        if len(self.observations) > 1:
            return self.observations.pop(0)
        return self.observations[0]

late = FakeContext([[], [], [ready]])
assert probe.isolate_partial_failure_session(
    late,
    {"sessionName": "owned", "sessionId": "session-1"},
    timeout_seconds=0.1,
    poll_seconds=0.001,
) == ready
assert late.calls == 3

empty = FakeContext([[]])
assert probe.isolate_partial_failure_session(
    empty,
    {"sessionName": "owned"},
    timeout_seconds=0.01,
    poll_seconds=0.001,
) is None
assert empty.calls >= probe.MINIMUM_EMPTY_FAILURE_CENSUS_OBSERVATIONS

vanished = FakeContext([[
    {
        "session_name": "owned",
        "session_id": "session-1",
        "lifecycle": "starting",
    }
], []])
try:
    probe.isolate_partial_failure_session(
        vanished,
        {"sessionName": "owned", "sessionId": "session-1"},
        timeout_seconds=0.01,
        poll_seconds=0.001,
    )
except probe.ProbeFailure as error:
    assert "generation-fenceable" in str(error)
else:
    raise AssertionError("a seen session was accepted after disappearing")
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("restores authorized_keys bytes and metadata exactly", () => {
    const result = runProbeUnit(String.raw`
import base64
import importlib.util
import os
import pathlib
import sys
import tempfile
import types

spec = importlib.util.spec_from_file_location("artifact_probe", sys.argv[1])
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    ssh = root / ".ssh"
    ssh.mkdir(mode=0o700)
    authorized = ssh / "authorized_keys"
    before = b"existing-key\n"
    entry = "command=\"owned\",restrict ssh-ed25519 AAAA owned"
    installed = before + entry.encode() + b"\n"
    authorized.write_bytes(installed)
    os.chmod(authorized, 0o600)
    probe.pwd.getpwuid = lambda _: types.SimpleNamespace(pw_dir=str(root))
    state = {
        "remoteAuthorization": {
            "schemaVersion": 1,
            "authorizedKeysPath": str(authorized),
            "beforeBase64": base64.b64encode(before).decode(),
            "entry": entry,
            "existedBefore": True,
            "modeBefore": 0o640,
            "uidBefore": os.getuid(),
            "gidBefore": os.getgid(),
        }
    }
    assert probe.restore_remote_authorization(object(), state) is True
    assert authorized.read_bytes() == before
    assert authorized.stat().st_mode & 0o777 == 0o640
    assert authorized.stat().st_uid == os.getuid()
    assert authorized.stat().st_gid == os.getgid()

    os.chmod(authorized, 0o644)
    try:
        probe.restore_remote_authorization(object(), state)
    except probe.ProbeFailure as error:
        assert "different metadata" in str(error)
    else:
        raise AssertionError("metadata drift was accepted as exact restoration")
`);
    expect(result.status, result.stderr).toBe(0);
  });

  test("exercises exact-artifact pairing and a synthetic pointer saga", () => {
    expect(driver).toContain('run_phase pairing "$triple"');
    expect(driver).toContain('run_phase activation "$triple"');
    expect(probe).toContain('b"hmux-pairing-request-v1"');
    expect(probe).toContain('"provenRequestAccepted": True');
    expect(probe).toContain('"provenResponseAccepted": True');
    expect(probe).toContain('"authenticatedEndpointUsed": True');
    expect(probe).toContain('"realHostKeyPinned": True');
    expect(probe).toContain('"forcedCommandInstalled": True');
    expect(probe).toContain('"syntheticPointerSaga": True');
    expect(probe).toContain('"syntheticPointerRollback": True');
    expect(probe).toContain('"failedCandidateRejected": True');
    expect(probe).toContain('"failedCandidatePreservedPointer": True');
    expect(probe).toContain('"exactArtifactReactivated": True');
    expect(probe).toContain('"revokedCredentialRejected": True');
    expect(probe).not.toContain('"distinctValidUpdate": True');
    expect(probe).not.toContain('"previousVersionRollback": True');
    expect(probe).not.toContain('"skipped": True');
  });

  test("keeps uploaded failures bounded and redacted", () => {
    expect(driver).toContain('"detailRedacted": True');
    expect(driver).toContain('"redactedDetailSha256": sys.argv[5]');
    expect(driver).toContain(
      'write_run_receipt failed \\\n      "$on_exit_final_status"',
    );
    expect(driver).toContain('"triggerExitCode": int(sys.argv[6])');
    expect(driver).toContain('"cleanupSucceeded": sys.argv[7] == "1"');
    expect(driver).toContain('rm -f "$receipt.tmp"');
    expect(driver).toContain('rm -f "$raw_error"');
    expect(driver).toContain("-name '.raw-*' -delete");
    expect(driver).toContain("HMUX_LINUX_ARTIFACT_SCREEN_READS");
    expect(probe).toContain("screen_reads > 10_000");
    expect(probe).toContain("MAX_SUBPROCESS_OUTPUT_BYTES");
    expect(probe).not.toContain("print(payload)");
    expect(probe).not.toContain("print(token)");
  });

  test("binds executed archive bytes to the published digest evidence", () => {
    expect(driver).toContain('"$artifact_stage/SHA256SUMS"');
    expect(driver).toContain("shasum -a 256 -c SHA256SUMS");
    expect(driver).toContain('declared_digest=$(');
    expect(driver).toContain('"archiveSha256": sys.argv[8]');
    expect(driver).toContain('"archiveSha256": sys.argv[9]');
    expect(driver).toContain('"driverSha256": sys.argv[10]');
    expect(driver).toContain('"probeSha256": sys.argv[11]');
    expect(driver).toContain('"installerSha256": sys.argv[12]');
    expect(driver).toContain('"limaTemplateSha256": sys.argv[13]');
    expect(driver).toContain('"server": sys.argv[14]');
    expect(driver).toContain('"client": sys.argv[15] if remote_carrier else None');
  });

  test("fails closed when exact cleanup of either VM cannot be observed", () => {
    expect(driver).toContain(
      'if ! vm_list=$(lima_cleanup list -q 2>/dev/null); then',
    );
    expect(driver).toContain('cleanup_one_vm "$client_vm_name"');
    expect(driver).toContain('cleanup_one_vm "$vm_name"');
    expect(driver).toContain("could not prove exact VM cleanup");
  });

  test("cleans the exact server after a partial two-VM startup", () => {
    const fixture = partialStartFixture();
    try {
      expect(fixture.result.status).toBe(42);
      const serverStart = fixture.calls.find((call) =>
        call.startsWith("start --tty=false --name hmux-artifact-"),
      );
      const clientStart = fixture.calls.find((call) =>
        call.includes("-client --network=lima:user-v2"),
      );
      expect(serverStart).toBeDefined();
      expect(clientStart).toBeDefined();
      const server = serverStart.match(/--name ([^ ]+)/)?.[1];
      expect(server).toMatch(/^hmux-artifact-manual-attempt-0-[0-9]+$/);
      expect(fixture.calls).toContain(`delete --force ${server}-client`);
      expect(fixture.calls).toContain(`delete --force ${server}`);
      expect(fs.readFileSync(fixture.state, "utf8")).toBe("");
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.evidence, "run.json"), "utf8"),
        ),
      ).toMatchObject({
          ok: false,
          exitCode: 42,
          triggerExitCode: 42,
          cleanupSucceeded: true,
          detailRedacted: true,
        });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("turns a failed exact VM deletion proof into a failed receipt", () => {
    const fixture = partialStartFixture({ stickyDelete: true });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "exact VM cleanup was not proven",
      );
      expect(fs.readFileSync(fixture.state, "utf8")).toContain(
        "hmux-artifact-manual-attempt-0-",
      );
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.evidence, "run.json"), "utf8"),
        ),
      ).toMatchObject({
        ok: false,
        exitCode: 1,
        triggerExitCode: 42,
        cleanupSucceeded: false,
        detailRedacted: true,
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("fallback cleanup is bounded and fails closed on census or deletion", () => {
    const runFixture = ({ listFails = false, sticky = false } = {}) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "hmux-exact-cleanup-"),
      );
      const bin = path.join(root, "bin");
      const state = path.join(root, "state");
      const calls = path.join(root, "calls");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        state,
        "hmux-artifact-owned-client\nhmux-artifact-owned\nother-vm\n",
      );
      executable(
        path.join(bin, "limactl"),
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$FAKE_LIMA_CALLS"
case "\${1:-}" in
  --version)
    printf '%s\\n' 'limactl version 1.2.1'
    ;;
  stop)
    ;;
  delete)
    instance=$3
    if [ "\${FAKE_LIMA_STICKY:-0}" != 1 ]; then
      grep -Fxv "$instance" "$FAKE_LIMA_STATE" >"$FAKE_LIMA_STATE.tmp" || true
      mv "$FAKE_LIMA_STATE.tmp" "$FAKE_LIMA_STATE"
    fi
    ;;
  list)
    [ "\${FAKE_LIMA_LIST_FAILS:-0}" != 1 ] || exit 44
    cat "$FAKE_LIMA_STATE"
    ;;
  *)
    exit 45
    ;;
esac
`,
      );
      const result = spawnSync(
        "python3",
        [
          exactCleanupPath,
          "hmux-artifact-owned-client",
          "hmux-artifact-owned",
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_LIMA_CALLS: calls,
            FAKE_LIMA_LIST_FAILS: listFails ? "1" : "0",
            FAKE_LIMA_STATE: state,
            FAKE_LIMA_STICKY: sticky ? "1" : "0",
            PYTHONDONTWRITEBYTECODE: "1",
          },
          encoding: "utf8",
        },
      );
      return { calls, result, root, state };
    };

    const success = runFixture();
    try {
      expect(success.result.status, success.result.stderr).toBe(0);
      expect(fs.readFileSync(success.state, "utf8")).toBe("other-vm\n");
      expect(fs.readFileSync(success.calls, "utf8")).toContain("list -q");
    } finally {
      fs.rmSync(success.root, { recursive: true, force: true });
    }

    for (const options of [{ sticky: true }, { listFails: true }]) {
      const failure = runFixture(options);
      try {
        expect(failure.result.status).toBe(1);
        expect(failure.result.stderr).toMatch(
          /exact Lima (census failed|cleanup left owned instances)/,
        );
      } finally {
        fs.rmSync(failure.root, { recursive: true, force: true });
      }
    }
  });

  test("fallback cleanup kills a timed-out limactl process group", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "hmux-exact-cleanup-timeout-"),
    );
    const bin = path.join(root, "bin");
    const childPid = path.join(root, "child-pid");
    fs.mkdirSync(bin);
    executable(
      path.join(bin, "limactl"),
      `#!/bin/sh
set -eu
case "\${1:-}" in
  hang)
    printf '%s\\n' "$$" >"$FAKE_LIMA_CHILD_PID"
    exec sleep 5
    ;;
  *)
    exit 45
    ;;
esac
`,
    );
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("exact_cleanup", sys.argv[1])
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
try:
    # A saturated full gate can delay the fixture child before its first
    # instruction. Keep the timeout focused on cleanup, not process startup.
    cleanup.bounded_lima(["hang"], timeout=2)
except cleanup.CleanupFailure as error:
    assert "timed out" in str(error)
else:
    raise AssertionError("hung limactl was accepted")
`,
        exactCleanupPath,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_LIMA_CHILD_PID: childPid,
          PYTHONDONTWRITEBYTECODE: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    try {
      expect(result.status, result.stderr).toBe(0);
      // 포화된 호스트에서는 픽스처 자식이 첫 명령(pid 기록)을 실행하기 전에
      // bounded cleanup(2초)이 먼저 죽일 수 있다 — 2026-07-31 CI에서 ENOENT로
      // 실측됐다. 그 경우 exec sleep은 시작조차 못 했으므로 살아남을 프로세스가
      // 없다: pid 파일 부재는 "정리가 더 일찍 이겼다"는 뜻이지 실패가 아니다.
      // 파일이 있을 때만 그 pid가 실제로 죽었는지 본다. 타임아웃을 늘리는
      // 것으로는 경합이 좁아질 뿐 사라지지 않고, 정상 경로만 그만큼 느려진다.
      if (fs.existsSync(childPid)) {
        const pid = fs.readFileSync(childPid, "utf8").trim();
        if (pid !== "") {
          expect(spawnSync("kill", ["-0", pid]).status).not.toBe(0);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

  test("does not rebuild release artifacts for private test modules", () => {
    for (const path of [
      "hmux/crates/hmux-client/src/tests.rs",
      "hmux/crates/hmux-client/src/recovery/tests/overflow.rs",
    ]) {
      expect(requiresHmuxArtifact([path]), path).toBe(false);
    }
    for (const path of [
      "hmux/crates/hmux-client/tests/recovery.rs",
      "hmux/crates/hmux-client/src/recovery.rs",
    ]) {
      expect(requiresHmuxArtifact([path]), path).toBe(true);
    }
  });
