#!/usr/bin/env python3
"""Exercise an unpacked, shipped Hmux tree without rebuilding it.

Each invocation is deliberately one bounded phase. The Lima driver reconnects
between `prepare` and `resume`, so a green result proves the Host survived an
actual SSH carrier disconnect rather than two calls in one login shell.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import platform
import pwd
import select
import selectors
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any


COMMAND_TIMEOUT_SECONDS = 20
MAX_SUBPROCESS_OUTPUT_BYTES = 1024 * 1024
ATTACH_OBSERVATION_SECONDS = 1.0
PROCESS_EXIT_TIMEOUT_SECONDS = 8.0
FAILURE_CENSUS_TIMEOUT_SECONDS = 8.0
FAILURE_CENSUS_POLL_SECONDS = 0.05
MINIMUM_EMPTY_FAILURE_CENSUS_OBSERVATIONS = 3
PAIRING_TIMEOUT_SECONDS = 30
FENCE_FIELDS = (
    "workspace_id",
    "session_id",
    "runner_principal",
    "runner_instance",
    "channel_epoch",
    "host_instance_id",
    "terminal_epoch",
)
PROTOCOL_VERSION = {"major": 1, "minor": 0}
PRODUCT_PROFILE = "structured-terminal-v1"
STRUCTURED_BASE_CAPABILITIES = (
    "screen_snapshot",
    "live_output",
)
STRUCTURED_TERMINAL_CAPABILITIES = (
    "terminal_state_binary_v1",
    "terminal_viewport_projection_v1",
    "terminal_input_intent_v1",
    "terminal_viewport_wheel_v1",
    "terminal_viewport_multipart_v1",
)
TERMINAL_ENVELOPE_HEADER_BYTES = 20
VIEWPORT_FRAME_KIND = 8
VIEWPORT_FRAME_PART_KIND = 12


class ProbeFailure(RuntimeError):
    pass


class InjectedProbeFault(ProbeFailure):
    pass


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_replace_bytes(
    path: Path,
    payload: bytes,
    mode: int = 0o600,
    owner: tuple[int, int] | None = None,
) -> None:
    temporary = path.with_name(f".{path.name}.hmux-native.tmp")
    if temporary.exists() or temporary.is_symlink():
        if temporary.is_symlink() or not temporary.is_file():
            raise ProbeFailure(f"unsafe temporary path for {path.name}")
        temporary.unlink()
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        mode,
    )
    try:
        with os.fdopen(descriptor, "wb") as file:
            os.fchmod(file.fileno(), mode)
            if owner is not None:
                os.fchown(file.fileno(), owner[0], owner[1])
            file.write(payload)
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, path)
    fsync_directory(path.parent)


def monotonic_millis() -> int:
    return round(time.monotonic() * 1000)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProbeFailure(f"could not read JSON document {path.name}") from error
    if not isinstance(value, dict):
        raise ProbeFailure(f"{path.name} is not a JSON object")
    return value


def parse_json_output(result: subprocess.CompletedProcess[str], label: str) -> Any:
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ProbeFailure(f"{label} did not return JSON") from error


def run(
    command: list[str],
    *,
    environment: dict[str, str],
    timeout: float = COMMAND_TIMEOUT_SECONDS,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        child = subprocess.Popen(
            command,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise ProbeFailure(f"subprocess did not complete: {Path(command[0]).name}") from error
    assert child.stdout is not None and child.stderr is not None
    output = {"stdout": bytearray(), "stderr": bytearray()}
    streams = selectors.DefaultSelector()
    for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
        os.set_blocking(stream.fileno(), False)
        streams.register(stream, selectors.EVENT_READ, name)
    deadline = time.monotonic() + timeout
    failure: ProbeFailure | None = None
    while streams.get_map():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            failure = ProbeFailure(
                f"subprocess timed out: {Path(command[0]).name}"
            )
            break
        for key, _ in streams.select(min(remaining, 0.25)):
            try:
                chunk = os.read(key.fileobj.fileno(), 64 * 1024)
            except BlockingIOError:
                continue
            if not chunk:
                streams.unregister(key.fileobj)
                continue
            destination = output[key.data]
            if len(destination) + len(chunk) > MAX_SUBPROCESS_OUTPUT_BYTES:
                failure = ProbeFailure(
                    f"subprocess exceeded output budget: {Path(command[0]).name}"
                )
                break
            destination.extend(chunk)
        if failure is not None:
            break
    streams.close()
    if failure is not None:
        child.kill()
        child.wait(timeout=3)
        raise failure
    try:
        return_code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
    except subprocess.TimeoutExpired as error:
        child.kill()
        child.wait(timeout=3)
        raise ProbeFailure(
            f"subprocess timed out: {Path(command[0]).name}"
        ) from error
    result = subprocess.CompletedProcess(
        command,
        return_code,
        output["stdout"].decode(errors="replace"),
        output["stderr"].decode(errors="replace"),
    )
    if check and result.returncode != 0:
        raise ProbeFailure(
            f"subprocess failed ({result.returncode}): {Path(command[0]).name}"
        )
    return result


class Context:
    def __init__(self, arguments: argparse.Namespace) -> None:
        self.tree = Path(arguments.tree).resolve()
        self.triple = arguments.triple
        self.state_root = Path(arguments.state_root).resolve()
        self.expected_source = arguments.expected_source
        self.probe_state = self.state_root / "probe-state.json"
        self.discovery_root = self.state_root / "discovery"
        self.home = self.state_root / "home"
        self.hmux = self.tree / "bin/hmux"
        self.runtime = self.tree / "bin/hmux-runtime"
        self.manifest = load_json(self.tree / "install.json")
        self.build_id = self.required_manifest_string("buildId")
        self.validate_inputs()

    def required_manifest_string(self, field: str) -> str:
        value = self.manifest.get(field)
        if not isinstance(value, str) or not value:
            raise ProbeFailure(f"install.json has no usable {field}")
        return value

    def validate_inputs(self) -> None:
        if platform.system() != "Linux":
            raise ProbeFailure("artifact probe must run inside Linux")
        if self.required_manifest_string("targetTriple") != self.triple:
            raise ProbeFailure("archive target and install.json target disagree")
        if self.manifest.get("schemaVersion") != 1:
            raise ProbeFailure("unsupported install.json schema")
        for binary in (self.hmux, self.runtime):
            if not binary.is_file() or not os.access(binary, os.X_OK):
                raise ProbeFailure(f"artifact is missing executable {binary.name}")
            if binary.is_symlink():
                raise ProbeFailure(f"artifact executable must not be a symlink: {binary.name}")
        parent = self.state_root.parent
        if not self.state_root.name.startswith("state-") or not parent.name.startswith(
            "hmux-linux-artifact-"
        ):
            raise ProbeFailure("state root is outside the dedicated artifact probe root")

    def environment(self) -> dict[str, str]:
        environment = dict(os.environ)
        environment.update(
            {
                "HOME": str(self.home),
                "HMUX_RUNTIME": str(self.runtime),
                "PATH": f"{self.tree / 'bin'}:{environment.get('PATH', '')}",
                "SHELL": "/bin/sh",
                "TERM": "xterm-256color",
            }
        )
        return environment

    def command(self, *arguments: str) -> list[str]:
        return [
            str(self.hmux),
            "--discovery-root",
            str(self.discovery_root),
            *arguments,
        ]

    def list_sessions(self) -> list[dict[str, Any]]:
        payload = parse_json_output(
            run(self.command("ls", "--json"), environment=self.environment()),
            "hmux ls",
        )
        if not isinstance(payload, list):
            raise ProbeFailure("hmux ls did not return a session array")
        return payload

    def load_state(self) -> dict[str, Any]:
        return load_json(self.probe_state)

    def save_state(self, state: dict[str, Any]) -> None:
        atomic_replace_bytes(
            self.probe_state,
            (
                json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode(),
        )


def runtime_identity(context: Context) -> dict[str, Any]:
    runtime = parse_json_output(
        run(
            [str(context.runtime), "--no-autostart", "hmux-build-info"],
            environment=context.environment(),
        ),
        "hmux-runtime build info",
    )
    if not isinstance(runtime, dict):
        raise ProbeFailure("hmux-runtime build info is not an object")
    expected = {
        "buildId": context.build_id,
        "sourceCommit": context.expected_source,
        "targetTriple": context.triple,
    }
    for field, value in expected.items():
        if runtime.get(field) != value:
            raise ProbeFailure(f"hmux-runtime {field} disagrees with archive identity")
    if runtime.get("productProfile") != PRODUCT_PROFILE:
        raise ProbeFailure(
            "hmux-runtime product profile is not the structured terminal product"
        )

    capabilities = parse_json_output(
        run(
            [str(context.hmux), "capabilities", "--json"],
            environment=context.environment(),
        ),
        "hmux capabilities",
    )
    if not isinstance(capabilities, dict):
        raise ProbeFailure("hmux capabilities is not an object")
    build_info = capabilities.get("buildInfo")
    if not isinstance(build_info, dict) or build_info.get("buildId") != context.build_id:
        raise ProbeFailure("hmux CLI build ID disagrees with archive identity")
    return runtime


def session_fence(session: dict[str, Any]) -> dict[str, str]:
    fence: dict[str, str] = {}
    for field in FENCE_FIELDS:
        value = session.get(field)
        if not isinstance(value, str) or not value:
            raise ProbeFailure(f"session census has no usable {field}")
        fence[field] = value
    return fence


def process_identity(session: dict[str, Any], field: str) -> tuple[int, str]:
    process = session.get(field)
    if not isinstance(process, dict):
        raise ProbeFailure(f"session census has no {field}")
    process_id = process.get("process_id")
    start_marker = process.get("start_marker")
    if not isinstance(process_id, int) or process_id <= 1:
        raise ProbeFailure(f"session census has no usable {field} PID")
    if not isinstance(start_marker, str) or not start_marker:
        raise ProbeFailure(f"session census has no usable {field} start marker")
    return process_id, start_marker


def exact_session(context: Context, state: dict[str, Any]) -> dict[str, Any]:
    sessions = context.list_sessions()
    matches = [
        session
        for session in sessions
        if session.get("session_name") == state["sessionName"]
        and session.get("session_id") == state["sessionId"]
    ]
    if len(sessions) != 1 or len(matches) != 1:
        raise ProbeFailure("isolated census does not contain exactly the owned session")
    session = matches[0]
    if session_fence(session) != state["fence"]:
        raise ProbeFailure("owned session generation changed")
    for key, field in (("host", "host_process"), ("provider", "provider_process")):
        process_id, start_marker = process_identity(session, field)
        if process_id != state[f"{key}Pid"] or start_marker != state[f"{key}StartMarker"]:
            raise ProbeFailure(f"owned {key} process identity changed")
    return session


def send_marker(context: Context, name: str, marker: str) -> None:
    for arguments in (
        ("--json", "send-keys", "-t", name, "--literal", f"printf '{marker}\\n'"),
        ("--json", "send-keys", "-t", name, "Enter"),
    ):
        payload = parse_json_output(
            run(context.command(*arguments), environment=context.environment()),
            "hmux send-keys",
        )
        if not isinstance(payload, dict) or payload.get("state") != "WrittenToPty":
            raise ProbeFailure("terminal marker was not written to the PTY")


def read_sequence(context: Context, name: str, marker: str) -> int:
    for _ in range(40):
        recent = parse_json_output(
            run(
                context.command("--json", "read", "--lines", "30", name),
                environment=context.environment(),
            ),
            "hmux read",
        )
        if not isinstance(recent, dict):
            raise ProbeFailure("hmux read is not an object")
        lines = recent.get("lines")
        if not isinstance(lines, list):
            raise ProbeFailure("hmux read has no line array")
        if marker not in "\n".join(str(line) for line in lines):
            time.sleep(0.05)
            continue
        payload = parse_json_output(
            run(
                context.command("--json", "screen", name),
                environment=context.environment(),
            ),
            "hmux screen",
        )
        if not isinstance(payload, dict):
            raise ProbeFailure("hmux screen is not an object")
        sequence = payload.get("sequenceThrough")
        try:
            return int(sequence)
        except (TypeError, ValueError) as error:
            raise ProbeFailure("screen sequence is not numeric") from error
    raise ProbeFailure("terminal marker did not reach the bounded screen")


def process_alive(process_id: int) -> bool:
    stat = Path(f"/proc/{process_id}/stat")
    try:
        fields = stat.read_text(encoding="utf-8").split()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return len(fields) < 3 or fields[2] != "Z"


def prepare(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    if context.state_root.exists():
        raise ProbeFailure("prepare requires a fresh state root")
    context.home.mkdir(parents=True, mode=0o700)
    context.discovery_root.mkdir(mode=0o700)
    runtime = runtime_identity(context)
    if context.list_sessions():
        raise ProbeFailure("fresh discovery root was not empty")

    name = f"native-{context.triple.split('-', 1)[0]}-{os.getpid()}"
    intent = {"sessionName": name, "buildId": context.build_id}
    context.save_state(intent)
    created = parse_json_output(
        run(
            context.command("new", "--json", "--name", name),
            environment=context.environment(),
        ),
        "hmux new",
    )
    if not isinstance(created, dict) or not isinstance(created.get("sessionId"), str):
        raise ProbeFailure("hmux new returned no session identity")
    intent["sessionId"] = created["sessionId"]
    context.save_state(intent)

    session = None
    for _ in range(80):
        sessions = context.list_sessions()
        if (
            len(sessions) == 1
            and sessions[0].get("session_id") == intent["sessionId"]
            and sessions[0].get("lifecycle") == "ready"
        ):
            session = sessions[0]
            break
        time.sleep(0.05)
    if session is None:
        raise ProbeFailure("created session did not become ready")
    host_pid, host_start = process_identity(session, "host_process")
    provider_pid, provider_start = process_identity(session, "provider_process")
    state = {
        **intent,
        "fence": session_fence(session),
        "hostPid": host_pid,
        "hostStartMarker": host_start,
        "providerPid": provider_pid,
        "providerStartMarker": provider_start,
    }
    marker = f"HMUX_NATIVE_PREPARE_{intent['sessionId'].replace('-', '')}"
    send_marker(context, name, marker)
    state["sequence"] = read_sequence(context, name, marker)
    context.save_state(state)
    return {
        "ok": True,
        "phase": "prepare",
        "buildId": context.build_id,
        "sourceCommit": runtime["sourceCommit"],
        "targetTriple": context.triple,
        "sessionReady": True,
        "elapsedMs": monotonic_millis() - started,
    }


def resume(
    context: Context, screen_reads: int, minimum_soak_seconds: int
) -> dict[str, Any]:
    started = monotonic_millis()
    if screen_reads < 1 or screen_reads > 10_000:
        raise ProbeFailure("screen read budget must be from 1 through 10000")
    if minimum_soak_seconds < 0 or minimum_soak_seconds > 1_800:
        raise ProbeFailure("minimum soak must be from 0 through 1800 seconds")
    runtime_identity(context)
    state = context.load_state()
    session = exact_session(context, state)
    if session.get("lifecycle") != "ready":
        raise ProbeFailure("session was not ready after SSH carrier reconnect")
    if not process_alive(state["hostPid"]) or not process_alive(state["providerPid"]):
        raise ProbeFailure("Host or provider died across the SSH carrier disconnect")

    marker = f"HMUX_NATIVE_RESUME_{state['sessionId'].replace('-', '')}"
    send_marker(context, state["sessionName"], marker)
    sequence = read_sequence(context, state["sessionName"], marker)
    if sequence <= state["sequence"]:
        raise ProbeFailure("screen sequence did not advance after reconnect")

    try:
        attach = subprocess.Popen(
            context.command("attach", "--read-only", state["sessionName"]),
            env=context.environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise ProbeFailure("could not launch the read-only observer") from error
    assert attach.stdout is not None
    stdout = bytearray()
    deadline = time.monotonic() + ATTACH_OBSERVATION_SECONDS
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select(
                [attach.stdout], [], [], deadline - time.monotonic()
            )
            if not ready:
                break
            chunk = os.read(attach.stdout.fileno(), 64 * 1024)
            if not chunk:
                break
            stdout.extend(chunk)
            if len(stdout) > MAX_SUBPROCESS_OUTPUT_BYTES:
                raise ProbeFailure("read-only observer exceeded its output budget")
    finally:
        if attach.poll() is None:
            attach.terminate()
        try:
            attach.wait(timeout=3)
        except subprocess.TimeoutExpired:
            attach.kill()
            attach.wait(timeout=3)
    if marker.encode() not in stdout:
        raise ProbeFailure("reattached observer did not receive the current screen")
    if not process_alive(state["hostPid"]):
        raise ProbeFailure("disconnecting the observer stopped the Host")

    last_sequence = sequence
    soak_started = time.monotonic()
    for read_index in range(screen_reads):
        payload = parse_json_output(
            run(
                context.command("--json", "screen", state["sessionName"]),
                environment=context.environment(),
            ),
            "hmux screen",
        )
        try:
            current_sequence = int(payload["sequenceThrough"])
        except (KeyError, TypeError, ValueError) as error:
            raise ProbeFailure("soak screen sequence is not numeric") from error
        if current_sequence < last_sequence:
            raise ProbeFailure("screen sequence regressed during the bounded soak")
        last_sequence = current_sequence
        if minimum_soak_seconds:
            read_deadline = soak_started + (
                minimum_soak_seconds * (read_index + 1) / screen_reads
            )
            remaining = read_deadline - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
    exact_session(context, state)
    state["sequence"] = last_sequence
    context.save_state(state)
    return {
        "ok": True,
        "phase": "resume",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "carrierReconnected": True,
        "observerDetached": True,
        "screenReads": screen_reads + 1,
        "minimumSoakSeconds": minimum_soak_seconds,
        "elapsedMs": monotonic_millis() - started,
    }


def transcript(label: bytes, fields: list[bytes]) -> bytes:
    encoded = bytearray()
    for field in [label, *fields]:
        encoded.extend(len(field).to_bytes(8, "big"))
        encoded.extend(field)
    return bytes(encoded)


def encode_frame(kind: str, payload: dict[str, Any], frame_id: int = 1) -> bytes:
    frame = {
        "protocol_version": {"major": 1, "minor": 0},
        "frame_id": str(frame_id),
        "body": {"kind": kind, "payload": payload},
    }
    encoded = json.dumps(frame, separators=(",", ":")).encode()
    return len(encoded).to_bytes(4, "big") + encoded


class FramedReader:
    def __init__(self, stream: Any) -> None:
        self.stream = stream
        self.buffer = bytearray()

    def read_exact(self, length: int, timeout: float = 8.0) -> bytes:
        deadline = time.monotonic() + timeout
        while len(self.buffer) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeFailure("SSH gateway frame timed out")
            ready, _, _ = select.select([self.stream], [], [], remaining)
            if not ready:
                raise ProbeFailure("SSH gateway frame timed out")
            chunk = os.read(self.stream.fileno(), max(4096, length - len(self.buffer)))
            if not chunk:
                raise ProbeFailure("SSH gateway closed mid-frame")
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:length])
        del self.buffer[:length]
        return result

    def payload(self) -> bytes:
        length = int.from_bytes(self.read_exact(4), "big")
        if length < 1 or length > 2 * 1024 * 1024:
            raise ProbeFailure("SSH gateway emitted an unsafe frame length")
        return self.read_exact(length)

    def frame(self) -> dict[str, Any]:
        try:
            frame = json.loads(self.payload())
        except json.JSONDecodeError as error:
            raise ProbeFailure("SSH gateway emitted malformed JSON") from error
        if not isinstance(frame, dict):
            raise ProbeFailure("SSH gateway frame is not an object")
        return frame


def frame_body(frame: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if frame.get("protocol_version") != PROTOCOL_VERSION:
        raise ProbeFailure("SSH gateway frame used another protocol version")
    body = frame.get("body")
    if not isinstance(body, dict):
        raise ProbeFailure("SSH gateway frame has no body")
    kind = body.get("kind")
    payload = body.get("payload")
    if not isinstance(kind, str) or not isinstance(payload, dict):
        raise ProbeFailure("SSH gateway frame body is malformed")
    if kind == "error":
        raise ProbeFailure("SSH gateway refused the artifact-native attach")
    return kind, payload


def validate_structured_ack(
    acknowledgment: dict[str, Any], state: dict[str, Any]
) -> list[str]:
    if acknowledgment.get("selected_version") != PROTOCOL_VERSION:
        raise ProbeFailure("structured endpoint selected another protocol version")
    if acknowledgment.get("actual_fence") != state["fence"]:
        raise ProbeFailure("structured endpoint acknowledged another session fence")
    selected = acknowledgment.get("selected_capabilities")
    if (
        not isinstance(selected, list)
        or any(not isinstance(capability, str) for capability in selected)
        or len(selected) != len(set(selected))
    ):
        raise ProbeFailure("structured endpoint returned malformed capabilities")
    expected = set(STRUCTURED_TERMINAL_CAPABILITIES)
    if set(selected) != expected:
        raise ProbeFailure("structured endpoint did not select exactly the product profile")
    return sorted(selected)


def validate_structured_envelope(payload: bytes) -> tuple[int, int]:
    if len(payload) < TERMINAL_ENVELOPE_HEADER_BYTES:
        raise ProbeFailure("structured endpoint returned a truncated terminal envelope")
    if payload[:4] != b"TSPB":
        raise ProbeFailure("structured endpoint returned the wrong terminal envelope magic")
    if payload[4] != 1:
        raise ProbeFailure("structured endpoint returned another terminal envelope major")
    if payload[7] != 0:
        raise ProbeFailure("structured endpoint returned nonzero terminal envelope flags")
    payload_length = int.from_bytes(payload[8:12], "little")
    if payload_length != len(payload) - TERMINAL_ENVELOPE_HEADER_BYTES:
        raise ProbeFailure("structured endpoint returned a mismatched terminal payload length")
    record_id = int.from_bytes(payload[12:20], "little")
    if record_id == 0:
        raise ProbeFailure("structured endpoint returned a zero terminal record id")
    record_kind = payload[6]
    if record_kind not in (VIEWPORT_FRAME_KIND, VIEWPORT_FRAME_PART_KIND):
        raise ProbeFailure("structured endpoint returned no initial viewport record")
    expected_minor = 4 if record_kind == VIEWPORT_FRAME_KIND else 5
    if payload[5] != expected_minor:
        raise ProbeFailure(
            "structured endpoint returned the wrong terminal envelope minor for its record kind"
        )
    return record_kind, record_id


def structured_hello_payload(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "supported_versions": {
            "minimum": {"major": 1, "minor": 0},
            "maximum": {"major": 1, "minor": 0},
        },
        "requested_capabilities": [
            *STRUCTURED_BASE_CAPABILITIES,
            *STRUCTURED_TERMINAL_CAPABILITIES,
        ],
        "expected_fence": state["fence"],
        "requested_mode": "observer",
        "reconnect_cursor": None,
        "capability_token": "artifact-native-relay-grant",
        "authorization_proof_reference": None,
    }


def read_structured_attach_seed(
    reader: FramedReader, state: dict[str, Any]
) -> tuple[list[str], int, int]:
    kind, acknowledgment = frame_body(reader.frame())
    if kind != "hello_ack":
        raise ProbeFailure("structured endpoint returned no HelloAck")
    selected = validate_structured_ack(acknowledgment, state)
    record_kind, record_id = validate_structured_envelope(reader.payload())
    return selected, record_kind, record_id


def validate_remote_ack(
    acknowledgment: dict[str, Any],
    state: dict[str, Any],
    *,
    require_resume: bool,
) -> int:
    if acknowledgment.get("selected_version") != PROTOCOL_VERSION:
        raise ProbeFailure("remote endpoint selected another protocol version")
    if acknowledgment.get("actual_fence") != state["fence"]:
        raise ProbeFailure("remote endpoint acknowledged another session fence")
    selected = acknowledgment.get("selected_capabilities")
    if (
        not isinstance(selected, list)
        or any(not isinstance(capability, str) for capability in selected)
        or len(selected) != len(set(selected))
    ):
        raise ProbeFailure("remote endpoint returned malformed capabilities")
    selected_set = set(selected)
    requested_set = {
        "screen_snapshot",
        "live_output",
        "reconnect_resume_v1",
    }
    required_set = {"screen_snapshot", "live_output"}
    if require_resume:
        required_set.add("reconnect_resume_v1")
    if not required_set.issubset(selected_set):
        raise ProbeFailure("remote endpoint omitted an observer capability")
    if not selected_set.issubset(requested_set):
        raise ProbeFailure("remote endpoint granted an unrequested capability")
    if require_resume and "reconnect_resume_v1" not in selected:
        raise ProbeFailure("remote endpoint did not negotiate reconnect resume")
    try:
        current_sequence = int(acknowledgment["current_output_seq"])
    except (KeyError, TypeError, ValueError) as error:
        raise ProbeFailure("remote endpoint returned no current cursor") from error
    if current_sequence < 0:
        raise ProbeFailure("remote endpoint returned a negative cursor")
    return current_sequence


def validate_remote_snapshot(
    snapshot: dict[str, Any],
    state: dict[str, Any],
    current_sequence: int,
) -> int:
    if snapshot.get("fence") != state["fence"]:
        raise ProbeFailure("remote snapshot carried another session fence")
    try:
        snapshot_sequence = int(snapshot["sequence_through"])
    except (KeyError, TypeError, ValueError) as error:
        raise ProbeFailure("remote endpoint returned no canonical cursor") from error
    if snapshot_sequence < current_sequence:
        raise ProbeFailure("remote snapshot predates its HelloAck")
    return snapshot_sequence


def hello_payload(
    state: dict[str, Any], reconnect_cursor: dict[str, str] | None
) -> dict[str, Any]:
    return {
        "supported_versions": {
            "minimum": {"major": 1, "minor": 0},
            "maximum": {"major": 1, "minor": 0},
        },
        "requested_capabilities": [
            "screen_snapshot",
            "live_output",
            "reconnect_resume_v1",
        ],
        "expected_fence": state["fence"],
        "requested_mode": "observer",
        "reconnect_cursor": reconnect_cursor,
        # A scoped gateway grant is not implemented yet. This value is still
        # mandatory on the wire, but the artifact gateway replaces it with the
        # locally read Host capability and never persists or reflects it.
        "capability_token": "artifact-native-relay-grant",
        "authorization_proof_reference": None,
    }


def ssh_gateway(
    *,
    environment: dict[str, str],
    identity: Path,
    known_hosts: Path,
    host: str,
    port: int,
    user: str,
) -> subprocess.Popen[bytes]:
    try:
        return subprocess.Popen(
            [
                "ssh",
                "-T",
                "-i",
                str(identity),
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "LogLevel=ERROR",
                "-o",
                "PasswordAuthentication=no",
                "-o",
                f"UserKnownHostsFile={known_hosts}",
                "-o",
                "StrictHostKeyChecking=yes",
                "-p",
                str(port),
                f"{user}@{host}",
                "artifact-native-probe",
            ],
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise ProbeFailure("could not launch the real SSH client") from error


def stop_ssh_gateway(child: subprocess.Popen[bytes]) -> None:
    if child.poll() is None:
        child.terminate()
    try:
        child.communicate(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.communicate(timeout=3)


def structured_attach(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    runtime = runtime_identity(context)
    state = context.load_state()
    session = exact_session(context, state)
    if session.get("lifecycle") != "ready":
        raise ProbeFailure("session was not ready for the structured attach")
    try:
        child = subprocess.Popen(
            context.command(
                "mobile-gateway",
                "--session",
                state["sessionId"],
                "--role",
                "controller",
            ),
            env=context.environment(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise ProbeFailure("could not launch the structured mobile gateway") from error
    try:
        assert child.stdin is not None and child.stdout is not None
        child.stdin.write(
            encode_frame("hello", structured_hello_payload(state))
        )
        child.stdin.flush()
        reader = FramedReader(child.stdout)
        selected, record_kind, record_id = read_structured_attach_seed(reader, state)
    finally:
        stop_ssh_gateway(child)
    exact_session(context, state)
    return {
        "ok": True,
        "phase": "structured_attach",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "productProfile": runtime["productProfile"],
        "selectedStructuredCapabilities": selected,
        "initialStructuredViewport": True,
        "viewportRecordKind": (
            "viewport_frame"
            if record_kind == VIEWPORT_FRAME_KIND
            else "viewport_frame_part"
        ),
        "recordIdNonzero": record_id > 0,
        "elapsedMs": monotonic_millis() - started,
    }


def scanned_ed25519_key(scanned: str) -> tuple[str, str, bytes]:
    for line in scanned.splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[1] != "ssh-ed25519":
            continue
        try:
            blob = base64.b64decode(fields[2], validate=True)
        except ValueError as error:
            raise ProbeFailure("real sshd exposed a malformed ed25519 key") from error
        return fields[1], fields[2], blob
    raise ProbeFailure("real sshd key scan had no usable ed25519 key")


def remote_client_paths(context: Context) -> tuple[Path, Path]:
    return (
        context.state_root / "remote-client-key",
        context.state_root / "known-hosts",
    )


def remote_client_prepare(
    context: Context,
    host: str,
    expected_host_public_key: str,
) -> dict[str, Any]:
    started = monotonic_millis()
    context.state_root.mkdir(parents=True, mode=0o700, exist_ok=False)
    identity, known_hosts = remote_client_paths(context)
    run(
        [
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            str(identity),
        ],
        environment=context.environment(),
    )
    generated_public_key = (
        identity.with_suffix(".pub").read_text(encoding="utf-8").strip()
    )
    public_key_fields = generated_public_key.split()
    if (
        "\n" in generated_public_key
        or len(public_key_fields) < 2
        or public_key_fields[0] != "ssh-ed25519"
    ):
        raise ProbeFailure("remote client generated an unsafe public key")
    try:
        base64.b64decode(public_key_fields[1], validate=True)
    except ValueError as error:
        raise ProbeFailure("remote client generated a malformed public key") from error
    public_key = " ".join(public_key_fields[:2])
    identity.with_suffix(".pub").write_text(public_key + "\n", encoding="utf-8")
    scanned = run(
        ["ssh-keyscan", "-T", "5", "-t", "ed25519", host],
        environment=context.environment(),
    ).stdout
    algorithm, encoded_key, host_key_blob = scanned_ed25519_key(scanned)
    expected_fields = expected_host_public_key.split()
    if (
        len(expected_fields) != 2
        or expected_fields[0] != "ssh-ed25519"
        or [algorithm, encoded_key] != expected_fields
    ):
        raise ProbeFailure("network host key did not match the server control plane")
    known_hosts.write_text(
        f"{host} {algorithm} {encoded_key}\n",
        encoding="utf-8",
    )
    os.chmod(known_hosts, 0o600)
    return {
        "ok": True,
        "phase": "remote_client_prepare",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "clientKeySha256": hashlib.sha256(public_key.encode()).hexdigest(),
        "hostKeyAlgorithm": algorithm,
        "hostKeyFingerprint": "SHA256:"
        + base64.b64encode(hashlib.sha256(host_key_blob).digest()).decode().rstrip("="),
        "knownHostKeySha256": hashlib.sha256(encoded_key.encode()).hexdigest(),
        "elapsedMs": monotonic_millis() - started,
    }


def remote_forced_command(context: Context) -> str:
    return (
        f'"{context.hmux}" --discovery-root '
        f'"{context.discovery_root}" mobile-gateway'
    )


def restore_remote_authorization(
    context: Context, state: dict[str, Any]
) -> bool:
    journal = state.get("remoteAuthorization")
    if journal is None:
        return False
    if not isinstance(journal, dict) or journal.get("schemaVersion") != 1:
        raise ProbeFailure("remote authorization journal is malformed")
    account = pwd.getpwuid(os.getuid())
    authorized_keys = Path(account.pw_dir) / ".ssh/authorized_keys"
    if journal.get("authorizedKeysPath") != str(authorized_keys):
        raise ProbeFailure("remote authorization journal names another key file")
    try:
        before = base64.b64decode(journal["beforeBase64"], validate=True)
        entry = journal["entry"].encode()
        existed_before = journal["existedBefore"]
        mode_before = journal["modeBefore"]
        uid_before = journal["uidBefore"]
        gid_before = journal["gidBefore"]
    except (KeyError, AttributeError, TypeError, ValueError) as error:
        raise ProbeFailure("remote authorization journal is incomplete") from error
    if (
        not isinstance(existed_before, bool)
        or not isinstance(mode_before, int)
        or not isinstance(uid_before, int)
        or not isinstance(gid_before, int)
    ):
        raise ProbeFailure("remote authorization journal metadata is malformed")
    separator = b"" if not before or before.endswith(b"\n") else b"\n"
    installed = before + separator + entry + b"\n"
    current_stat = None
    if authorized_keys.exists():
        if authorized_keys.is_symlink() or not authorized_keys.is_file():
            raise ProbeFailure("remote authorized_keys became unsafe")
        current = authorized_keys.read_bytes()
        current_stat = authorized_keys.stat()
    else:
        current = None
    restored = before if existed_before else None
    if current == restored:
        if existed_before and (
            current_stat is None
            or current_stat.st_mode & 0o777 != mode_before
            or current_stat.st_uid != uid_before
            or current_stat.st_gid != gid_before
        ):
            raise ProbeFailure(
                "remote authorized_keys bytes were restored with different metadata"
            )
        return False
    if current != installed:
        raise ProbeFailure("remote authorized_keys changed outside the owned entry")
    if existed_before:
        atomic_replace_bytes(
            authorized_keys,
            before,
            mode_before,
            (uid_before, gid_before),
        )
    else:
        authorized_keys.unlink()
        fsync_directory(authorized_keys.parent)
    if existed_before:
        restored_stat = authorized_keys.stat()
        if (
            authorized_keys.read_bytes() != before
            or restored_stat.st_mode & 0o777 != mode_before
            or restored_stat.st_uid != uid_before
            or restored_stat.st_gid != gid_before
        ):
            raise ProbeFailure("remote authorized_keys was not restored exactly")
    elif authorized_keys.exists() or authorized_keys.is_symlink():
        raise ProbeFailure("remote authorized_keys absence was not restored exactly")
    return True


def authorize_remote_client(
    context: Context,
    public_key: str,
    remote_host: str,
    *,
    fault_after_install: bool,
) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    exact_session(context, state)
    fields = public_key.split()
    if len(fields) != 2 or fields[0] != "ssh-ed25519":
        raise ProbeFailure("remote client public key is malformed")
    try:
        base64.b64decode(fields[1], validate=True)
    except ValueError as error:
        raise ProbeFailure("remote client public key is malformed") from error
    account = pwd.getpwuid(os.getuid())
    ssh_directory = Path(account.pw_dir) / ".ssh"
    if ssh_directory.exists() or ssh_directory.is_symlink():
        if ssh_directory.is_symlink() or not ssh_directory.is_dir():
            raise ProbeFailure("the isolated account has an unsafe .ssh path")
    else:
        ssh_directory.mkdir(parents=True, mode=0o700)
    authorized_keys = ssh_directory / "authorized_keys"
    if authorized_keys.is_symlink():
        raise ProbeFailure("the isolated account has a symlinked authorized_keys")
    existed_before = authorized_keys.exists()
    authorized_before = authorized_keys.read_bytes() if existed_before else b""
    authorized_before_stat = authorized_keys.stat() if existed_before else None
    mode_before = (
        authorized_before_stat.st_mode & 0o777
        if authorized_before_stat is not None
        else 0o600
    )
    uid_before = (
        authorized_before_stat.st_uid
        if authorized_before_stat is not None
        else os.getuid()
    )
    gid_before = (
        authorized_before_stat.st_gid
        if authorized_before_stat is not None
        else os.getgid()
    )
    escaped_command = (
        remote_forced_command(context).replace("\\", "\\\\").replace('"', '\\"')
    )
    entry = (
        f'command="{escaped_command}",restrict {public_key} '
        "hmux-native-two-endpoint"
    )
    if entry.encode() in authorized_before:
        raise ProbeFailure("remote client key was already authorized")
    separator = b"" if not authorized_before or authorized_before.endswith(b"\n") else b"\n"
    state["remoteAuthorization"] = {
        "schemaVersion": 1,
        "authorizedKeysPath": str(authorized_keys),
        "beforeBase64": base64.b64encode(authorized_before).decode(),
        "entry": entry,
        "existedBefore": existed_before,
        "modeBefore": mode_before,
        "uidBefore": uid_before,
        "gidBefore": gid_before,
        "state": "prepared",
        "remoteHost": remote_host,
        "remoteUser": account.pw_name,
    }
    context.save_state(state)
    atomic_replace_bytes(
        authorized_keys,
        authorized_before + separator + entry.encode() + b"\n",
    )
    if fault_after_install:
        raise InjectedProbeFault(
            "injected failure after authorization install and before applied marker"
        )
    state["remoteAuthorization"]["state"] = "applied"
    context.save_state(state)
    return {
        "ok": True,
        "phase": "authorize_remote",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "forcedCommandInstalled": True,
        "rollbackJournalPersistedBeforeInstall": True,
        "elapsedMs": monotonic_millis() - started,
    }


def remote_handoff(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    exact_session(context, state)
    document = {
        "schemaVersion": 1,
        "buildId": context.build_id,
        "sourceCommit": context.expected_source,
        "targetTriple": context.triple,
        "sessionId": state["sessionId"],
        "sessionName": state["sessionName"],
        "fence": state["fence"],
    }
    encoded = (
        json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    handoff = context.state_root / "remote-handoff.json"
    atomic_replace_bytes(handoff, encoded)
    return {
        "ok": True,
        "phase": "remote_handoff",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "handoffSha256": hashlib.sha256(encoded).hexdigest(),
        "elapsedMs": monotonic_millis() - started,
    }


def remote_state_import(
    context: Context, handoff_path: Path, expected_digest: str
) -> dict[str, Any]:
    started = monotonic_millis()
    if not context.state_root.is_dir() or context.probe_state.exists():
        raise ProbeFailure("remote state import requires prepared client state")
    try:
        encoded = handoff_path.read_bytes()
    except OSError as error:
        raise ProbeFailure("remote handoff was not transferred") from error
    actual_digest = hashlib.sha256(encoded).hexdigest()
    if actual_digest != expected_digest:
        raise ProbeFailure("remote handoff digest changed in transfer")
    try:
        document = json.loads(encoded)
    except json.JSONDecodeError as error:
        raise ProbeFailure("remote handoff was not JSON") from error
    if not isinstance(document, dict):
        raise ProbeFailure("remote handoff was not an object")
    expected = {
        "schemaVersion": 1,
        "buildId": context.build_id,
        "sourceCommit": context.expected_source,
        "targetTriple": context.triple,
    }
    if any(document.get(field) != value for field, value in expected.items()):
        raise ProbeFailure("remote handoff identity did not match the client artifact")
    if set(document) != {
        "schemaVersion",
        "buildId",
        "sourceCommit",
        "targetTriple",
        "sessionId",
        "sessionName",
        "fence",
    }:
        raise ProbeFailure("remote handoff carried an unexpected field")
    if (
        not isinstance(document.get("sessionId"), str)
        or not isinstance(document.get("sessionName"), str)
        or not isinstance(document.get("fence"), dict)
        or set(document["fence"]) != set(FENCE_FIELDS)
        or any(
            not isinstance(document["fence"].get(field), str)
            or not document["fence"][field]
            for field in FENCE_FIELDS
        )
    ):
        raise ProbeFailure("remote handoff session fence was incomplete")
    context.save_state(document)
    handoff_path.unlink()
    fsync_directory(handoff_path.parent)
    return {
        "ok": True,
        "phase": "remote_state_import",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "handoffSha256": actual_digest,
        "atomicImport": True,
        "elapsedMs": monotonic_millis() - started,
    }


def remote_client_open(context: Context, host: str, user: str) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    identity, known_hosts = remote_client_paths(context)
    child = ssh_gateway(
        environment=context.environment(),
        identity=identity,
        known_hosts=known_hosts,
        host=host,
        port=22,
        user=user,
    )
    try:
        assert child.stdin is not None and child.stdout is not None
        child.stdin.write(encode_frame("hello", hello_payload(state, None)))
        child.stdin.flush()
        reader = FramedReader(child.stdout)
        kind, acknowledgment = frame_body(reader.frame())
        if kind != "hello_ack":
            raise ProbeFailure("remote endpoint returned no HelloAck")
        current_sequence = validate_remote_ack(
            acknowledgment,
            state,
            require_resume=False,
        )
        snapshot = None
        for _ in range(8):
            kind, payload = frame_body(reader.frame())
            if kind == "screen_snapshot":
                snapshot = payload
                break
        if snapshot is None:
            raise ProbeFailure("remote endpoint returned no initial screen")
        cursor_sequence = validate_remote_snapshot(
            snapshot,
            state,
            current_sequence,
        )
    finally:
        stop_ssh_gateway(child)
    state.update(
        {
            "remoteCursor": str(cursor_sequence),
            "remoteHost": host,
            "remoteUser": user,
        }
    )
    context.save_state(state)
    return {
        "ok": True,
        "phase": "remote_open",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "carrierDroppedWithoutDetach": True,
        "elapsedMs": monotonic_millis() - started,
    }


def remote_resume_marker(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    exact_session(context, state)
    marker = f"HMUX_REMOTE_RESUME_{state['sessionId'].replace('-', '')}"
    send_marker(context, state["sessionName"], marker)
    sequence = read_sequence(context, state["sessionName"], marker)
    if sequence <= state["sequence"]:
        raise ProbeFailure("remote resume marker did not advance output")
    state["sequence"] = sequence
    context.save_state(state)
    return {
        "ok": True,
        "phase": "remote_marker",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "hostAndProviderAlive": True,
        "elapsedMs": monotonic_millis() - started,
    }


def remote_disconnected_soak(
    context: Context, minimum_soak_seconds: int
) -> dict[str, Any]:
    started = time.monotonic()
    if minimum_soak_seconds < 0 or minimum_soak_seconds > 1_800:
        raise ProbeFailure("remote disconnected soak must be from 0 through 1800 seconds")
    state = context.load_state()
    liveness_checks = max(1, min(30, (minimum_soak_seconds + 59) // 60))
    for check_index in range(liveness_checks):
        deadline = started + (
            minimum_soak_seconds * (check_index + 1) / liveness_checks
        )
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)
        exact_session(context, state)
        if not process_alive(state["hostPid"]) or not process_alive(
            state["providerPid"]
        ):
            raise ProbeFailure("Host or provider died while the remote carrier was down")
    observed_millis = round((time.monotonic() - started) * 1_000)
    if observed_millis < minimum_soak_seconds * 1_000:
        raise ProbeFailure("remote disconnected soak ended before its requested duration")
    return {
        "ok": True,
        "phase": "remote_disconnected_soak",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "carrierState": "client_ssh_process_terminated",
        "remoteCarrierDisconnectedMsObserved": observed_millis,
        "livenessChecks": liveness_checks,
        "hostAndProviderAlive": True,
    }


def remote_client_resume(context: Context, host: str, user: str) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    cursor_sequence = state.get("remoteCursor")
    if not isinstance(cursor_sequence, str) or not cursor_sequence.isdigit():
        raise ProbeFailure("remote client has no saved reconnect cursor")
    cursor = {
        "terminal_epoch": state["fence"]["terminal_epoch"],
        "after_output_seq": cursor_sequence,
    }
    identity, known_hosts = remote_client_paths(context)
    child = ssh_gateway(
        environment=context.environment(),
        identity=identity,
        known_hosts=known_hosts,
        host=host,
        port=22,
        user=user,
    )
    try:
        assert child.stdin is not None and child.stdout is not None
        child.stdin.write(encode_frame("hello", hello_payload(state, cursor)))
        child.stdin.flush()
        reader = FramedReader(child.stdout)
        kind, acknowledgment = frame_body(reader.frame())
        if kind != "hello_ack":
            raise ProbeFailure("remote reconnect returned no HelloAck")
        current_sequence = validate_remote_ack(
            acknowledgment,
            state,
            require_resume=True,
        )
        if current_sequence <= int(cursor_sequence):
            raise ProbeFailure("remote reconnect did not observe output after carrier drop")
        replayed = bytearray()
        last_sequence = int(cursor_sequence)
        for _ in range(64):
            kind, payload = frame_body(reader.frame())
            if kind in ("screen_snapshot", "replay_gap"):
                raise ProbeFailure("remote cursor reconnect redownloaded a snapshot")
            if kind != "output_delta":
                continue
            try:
                output_sequence = int(payload["output_seq"])
                output = base64.b64decode(payload["bytes"] + "===")
            except (KeyError, TypeError, ValueError) as error:
                raise ProbeFailure("remote resume delta was malformed") from error
            if payload.get("terminal_epoch") != state["fence"]["terminal_epoch"]:
                raise ProbeFailure("remote resume delta changed terminal epoch")
            if output_sequence != last_sequence + 1:
                raise ProbeFailure("remote resume output sequence was not contiguous")
            last_sequence = output_sequence
            replayed.extend(output)
            if len(replayed) > MAX_SUBPROCESS_OUTPUT_BYTES:
                raise ProbeFailure("remote reconnect replay exceeded its output budget")
            if last_sequence >= current_sequence:
                break
    finally:
        stop_ssh_gateway(child)
    marker = f"HMUX_REMOTE_RESUME_{state['sessionId'].replace('-', '')}".encode()
    if last_sequence != current_sequence or marker not in replayed:
        raise ProbeFailure("remote reconnect did not replay exactly through the current cursor")
    return {
        "ok": True,
        "phase": "remote_resume",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "cursorResumeWithoutSnapshot": True,
        "elapsedMs": monotonic_millis() - started,
    }


def revoke_remote_client(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    restored = restore_remote_authorization(context, state)
    if not restored:
        raise ProbeFailure("owned remote authorization entry was not removed")
    state["remoteAuthorization"]["state"] = "revoked"
    context.save_state(state)
    return {
        "ok": True,
        "phase": "revoke_remote",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "ownedEntryRemoved": True,
        "authorizedKeysBytesOwnerModeRestored": True,
        "elapsedMs": monotonic_millis() - started,
    }


def remote_client_rejected(context: Context, host: str, user: str) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    identity, known_hosts = remote_client_paths(context)
    pinned_algorithm, pinned_key, _ = scanned_ed25519_key(
        known_hosts.read_text(encoding="utf-8")
    )
    rescanned = run(
        ["ssh-keyscan", "-T", "5", "-t", "ed25519", host],
        environment=context.environment(),
    ).stdout
    algorithm, encoded_key, _ = scanned_ed25519_key(rescanned)
    if [algorithm, encoded_key] != [pinned_algorithm, pinned_key]:
        raise ProbeFailure("remote sshd identity changed before revocation proof")
    child = ssh_gateway(
        environment=context.environment(),
        identity=identity,
        known_hosts=known_hosts,
        host=host,
        port=22,
        user=user,
    )
    try:
        stdout, _ = child.communicate(
            input=encode_frame("hello", hello_payload(state, None)),
            timeout=8,
        )
    except subprocess.TimeoutExpired as error:
        child.kill()
        child.communicate(timeout=3)
        raise ProbeFailure("revoked remote credential did not fail promptly") from error
    if child.returncode != 255 or stdout:
        raise ProbeFailure("revoked remote credential still reached the Hmux gateway")
    return {
        "ok": True,
        "phase": "remote_rejected",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "topology": "two_vm_user_v2",
        "sameSshdReachableAfterRevocation": True,
        "revokedCredentialRejected": True,
        "elapsedMs": monotonic_millis() - started,
    }


def isolate_partial_failure_session(
    context: Context,
    state: dict[str, Any],
    *,
    timeout_seconds: float = FAILURE_CENSUS_TIMEOUT_SECONDS,
    poll_seconds: float = FAILURE_CENSUS_POLL_SECONDS,
) -> dict[str, Any] | None:
    session_name = state.get("sessionName")
    session_id = state.get("sessionId")
    if not isinstance(session_name, str) or not session_name:
        raise ProbeFailure("failed run has no owned session name")
    if session_id is not None and (
        not isinstance(session_id, str) or not session_id
    ):
        raise ProbeFailure("failed run has an unsafe session identity")
    deadline = time.monotonic() + timeout_seconds
    empty_observations = 0
    owned_session_seen = False
    while True:
        sessions = context.list_sessions()
        matches = [
            session
            for session in sessions
            if session.get("session_name") == session_name
            and (
                session_id is None
                or session.get("session_id") == session_id
            )
        ]
        if sessions and (len(sessions) != 1 or len(matches) != 1):
            raise ProbeFailure("failed run census did not isolate the owned session")
        if matches:
            owned_session_seen = True
            lifecycle = matches[0].get("lifecycle")
            if lifecycle in ("ready", "exited"):
                return matches[0]
            if lifecycle != "starting":
                raise ProbeFailure("failed run left an unsafe session lifecycle")
        else:
            empty_observations += 1
        if time.monotonic() >= deadline:
            if owned_session_seen:
                raise ProbeFailure(
                    "failed run session never reached a generation-fenceable lifecycle"
                )
            if empty_observations < MINIMUM_EMPTY_FAILURE_CENSUS_OBSERVATIONS:
                raise ProbeFailure("failed run had insufficient empty census evidence")
            return None
        time.sleep(poll_seconds)


def failure_cleanup(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    if not context.probe_state.exists():
        if context.state_root.exists():
            shutil.rmtree(context.state_root)
        return {
            "ok": True,
            "phase": "failure_cleanup",
            "buildId": context.build_id,
            "targetTriple": context.triple,
            "authorizationRestored": False,
            "sessionGenerationFenced": False,
            "elapsedMs": monotonic_millis() - started,
        }
    state = context.load_state()
    authorization_restored = restore_remote_authorization(context, state)
    session_cleaned = False
    required = {
        "sessionId",
        "sessionName",
        "fence",
        "hostPid",
        "providerPid",
    }
    if required.issubset(state):
        session = exact_session(context, state)
    else:
        # `failure-cleanup` is a separate probe invocation, so the failed
        # launcher has already returned. Discovery publication can still lag
        # that return; observe the isolated root through the full launch grace
        # before treating repeated empty censuses as authoritative absence.
        session = isolate_partial_failure_session(context, state)
    if session is not None:
        if session.get("lifecycle") not in ("ready", "exited"):
            raise ProbeFailure("failed run left an unsafe session lifecycle")
        fence_value = session_fence(session)
        host_pid, _ = process_identity(session, "host_process")
        provider_pid, _ = process_identity(session, "provider_process")
        fence = json.dumps(fence_value, separators=(",", ":"), sort_keys=True)
        run(
            context.command(
                "kill",
                session["session_id"],
                "--expected-fence-json",
                fence,
            ),
            environment=context.environment(),
        )
        deadline = time.monotonic() + PROCESS_EXIT_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if not process_alive(host_pid) and not process_alive(provider_pid):
                break
            time.sleep(0.05)
        if process_alive(host_pid) or process_alive(provider_pid):
            raise ProbeFailure("failed run Host or provider survived cleanup")
        session_cleaned = True
    shutil.rmtree(context.state_root)
    return {
        "ok": True,
        "phase": "failure_cleanup",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "authorizationRestored": authorization_restored,
        "sessionGenerationFenced": session_cleaned,
        "elapsedMs": monotonic_millis() - started,
    }


def prove_ssh_drop_and_resume(
    context: Context,
    state: dict[str, Any],
    environment: dict[str, str],
    identity: Path,
    known_hosts: Path,
    host: str,
    port: int,
    user: str,
) -> None:
    first = ssh_gateway(
        environment=environment,
        identity=identity,
        known_hosts=known_hosts,
        host=host,
        port=port,
        user=user,
    )
    try:
        assert first.stdin is not None and first.stdout is not None
        first.stdin.write(encode_frame("hello", hello_payload(state, None)))
        first.stdin.flush()
        first_reader = FramedReader(first.stdout)
        kind, first_ack = frame_body(first_reader.frame())
        if kind != "hello_ack":
            raise ProbeFailure("first SSH attach returned no HelloAck")

        snapshot = None
        for _ in range(8):
            kind, payload = frame_body(first_reader.frame())
            if kind == "screen_snapshot":
                snapshot = payload
                break
        if snapshot is None:
            raise ProbeFailure("first SSH attach returned no screen snapshot")
        cursor_sequence = snapshot.get("sequence_through")
        if not isinstance(cursor_sequence, str) or not cursor_sequence.isdigit():
            raise ProbeFailure("first SSH snapshot has no canonical cursor")
    finally:
        # Terminate the SSH process rather than sending Detach. This is the
        # carrier failure path: the far-side gateway sees EOF and the Host stays.
        stop_ssh_gateway(first)
    cursor = {
        "terminal_epoch": state["fence"]["terminal_epoch"],
        "after_output_seq": cursor_sequence,
    }

    if not process_alive(state["hostPid"]):
        raise ProbeFailure("dropping the real SSH carrier stopped the Host")

    marker = f"HMUX_SSH_RESUME_{state['sessionId'].replace('-', '')}"
    send_marker(context, state["sessionName"], marker)
    after_marker = read_sequence(context, state["sessionName"], marker)
    if after_marker <= int(cursor_sequence):
        raise ProbeFailure("SSH resume marker did not advance output")

    second = ssh_gateway(
        environment=environment,
        identity=identity,
        known_hosts=known_hosts,
        host=host,
        port=port,
        user=user,
    )
    try:
        assert second.stdin is not None and second.stdout is not None
        second.stdin.write(encode_frame("hello", hello_payload(state, cursor)))
        second.stdin.flush()
        second_reader = FramedReader(second.stdout)
        kind, second_ack = frame_body(second_reader.frame())
        if kind != "hello_ack":
            raise ProbeFailure("reconnected SSH attach returned no HelloAck")
        selected = second_ack.get("selected_capabilities")
        if not isinstance(selected, list) or "reconnect_resume_v1" not in selected:
            raise ProbeFailure("artifact gateway did not negotiate reconnect resume")
        try:
            current_sequence = int(second_ack["current_output_seq"])
        except (KeyError, TypeError, ValueError) as error:
            raise ProbeFailure("reconnected HelloAck has no current cursor") from error
        if current_sequence <= int(cursor_sequence):
            raise ProbeFailure("reconnected HelloAck did not observe post-drop output")

        replayed = bytearray()
        last_sequence = int(cursor_sequence)
        for _ in range(64):
            kind, payload = frame_body(second_reader.frame())
            if kind in ("screen_snapshot", "replay_gap"):
                raise ProbeFailure("cursor reconnect redownloaded a snapshot")
            if kind != "output_delta":
                continue
            try:
                output_sequence = int(payload["output_seq"])
                output = base64.b64decode(payload["bytes"] + "===")
            except (KeyError, TypeError, ValueError) as error:
                raise ProbeFailure("SSH resume delta was malformed") from error
            if output_sequence <= last_sequence:
                raise ProbeFailure("SSH resume output sequence regressed")
            last_sequence = output_sequence
            replayed.extend(output)
            if len(replayed) > MAX_SUBPROCESS_OUTPUT_BYTES:
                raise ProbeFailure("SSH reconnect replay exceeded its output budget")
            if last_sequence >= current_sequence:
                break
    finally:
        stop_ssh_gateway(second)
    if last_sequence != current_sequence or marker.encode() not in replayed:
        raise ProbeFailure("SSH reconnect did not replay exactly through the current cursor")


def pairing(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    pairing_root = context.state_root / "pairing"
    account = pwd.getpwuid(os.getuid())
    pairing_home = Path(account.pw_dir)
    ssh_directory = pairing_home / ".ssh"
    if ssh_directory.exists() or ssh_directory.is_symlink():
        if ssh_directory.is_symlink() or not ssh_directory.is_dir():
            raise ProbeFailure("the isolated account has an unsafe .ssh path")
    else:
        ssh_directory.mkdir(parents=True, mode=0o700)
    authorized_keys = ssh_directory / "authorized_keys"
    if authorized_keys.is_symlink():
        raise ProbeFailure("the isolated account has a symlinked authorized_keys")
    authorized_before = (
        authorized_keys.read_bytes() if authorized_keys.exists() else b""
    )
    inventory = pairing_root / "inventory.json"
    devices = pairing_root / "devices.json"
    host_key = pairing_root / "ssh_host_ed25519_key.pub"
    identity = pairing_root / "client-key"
    known_hosts = pairing_root / "known-hosts"
    pairing_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    inventory.write_text(
        '{"version":3,"agents":[],"projects":[],"sshHosts":[]}\n',
        encoding="utf-8",
    )
    run(
        [
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            str(identity),
        ],
        environment=context.environment(),
    )
    public_key = identity.with_suffix(".pub").read_text(encoding="utf-8").strip()
    scanned = run(
        ["ssh-keyscan", "-T", "5", "-t", "ed25519", "127.0.0.1"],
        environment=context.environment(),
    ).stdout
    if not scanned.strip():
        raise ProbeFailure("real sshd exposed no ed25519 host key")
    scanned_key = None
    for line in scanned.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[1] == "ssh-ed25519":
            scanned_key = fields[1:3]
            break
    if scanned_key is None:
        raise ProbeFailure("real sshd key scan had no usable ed25519 key")
    try:
        host_key_blob = base64.b64decode(scanned_key[1], validate=True)
    except ValueError as error:
        raise ProbeFailure("real sshd exposed a malformed ed25519 host key") from error
    host_key_digest = hashlib.sha256(host_key_blob).digest()
    host_key_compact = (
        base64.urlsafe_b64encode(host_key_digest).decode().rstrip("=")
    )
    host_key_display = (
        "SHA256:" + base64.b64encode(host_key_digest).decode().rstrip("=")
    )
    host_key.write_text(
        f"{scanned_key[0]} {scanned_key[1]} native-probe\n",
        encoding="utf-8",
    )
    known_hosts.write_text(scanned, encoding="utf-8")
    os.chmod(known_hosts, 0o600)
    environment = context.environment()
    forced_command = (
        f'"{context.hmux}" --discovery-root '
        f'"{context.discovery_root}" mobile-gateway'
    )
    environment.update(
        {
            "HOME": str(pairing_home),
            "HMUX_PAIRING_INVENTORY": str(inventory),
            "HMUX_PAIRING_DEVICES": str(devices),
        }
    )
    child = subprocess.Popen(
        [
            str(context.hmux),
            "pair",
            "start",
            "--address",
            "127.0.0.1",
            "--print-payload",
            "--port",
            "0",
            "--ttl-seconds",
            str(PAIRING_TIMEOUT_SECONDS),
            "--host-key",
            str(host_key),
            "--inventory",
            str(inventory),
            "--forced-command",
            forced_command,
        ],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    payload = None
    deadline = time.monotonic() + 10
    assert child.stdout is not None
    buffered = bytearray()
    while time.monotonic() < deadline:
        ready, _, _ = select.select([child.stdout], [], [], deadline - time.monotonic())
        if not ready:
            break
        chunk = os.read(child.stdout.fileno(), 4096)
        if not chunk:
            break
        buffered.extend(chunk)
        if len(buffered) > MAX_SUBPROCESS_OUTPUT_BYTES:
            child.kill()
            child.wait(timeout=3)
            raise ProbeFailure("pairing output exceeded its byte budget")
        for line in buffered.splitlines():
            if line.startswith(b"payload: "):
                payload = line.removeprefix(b"payload: ").strip().decode()
                break
        if payload is not None:
            break
    if payload is None:
        child.kill()
        child.wait(timeout=3)
        raise ProbeFailure("pairing window emitted no payload")

    try:
        query = payload.split("?", 1)[1]
        fields = dict(urllib.parse.parse_qsl(query))
        token = base64.urlsafe_b64decode(fields["t"] + "==")
        address = fields["a"]
        port = int(fields["p"])
        expires_at = int(fields["e"])
    except (KeyError, ValueError, IndexError) as error:
        child.kill()
        child.wait(timeout=3)
        raise ProbeFailure("pairing payload was malformed") from error
    now_millis = int(time.time() * 1000)
    if fields.get("k") != scanned_key[0] or fields.get("f") != host_key_compact:
        child.kill()
        child.wait(timeout=3)
        raise ProbeFailure("pairing payload did not pin the real sshd host key")
    if fields.get("rp") != "2":
        child.kill()
        child.wait(timeout=3)
        raise ProbeFailure("pairing payload did not require the authenticated response proof")
    if expires_at <= now_millis or expires_at > now_millis + (
        PAIRING_TIMEOUT_SECONDS + 5
    ) * 1000:
        child.kill()
        child.wait(timeout=3)
        raise ProbeFailure("pairing payload expiry was outside its bounded lifetime")
    nonce = bytes([3]) * 16
    proof_fields = [b"1", b"native artifact phone", public_key.encode(), nonce]
    proof = hmac.new(
        token,
        transcript(b"hmux-pairing-request-v1", proof_fields),
        hashlib.sha256,
    ).digest()
    request = {
        "version": 1,
        "device_name": "native artifact phone",
        "public_key": public_key,
        "nonce": base64.b64encode(nonce).decode(),
        "proof": base64.b64encode(proof).decode(),
    }
    with socket.create_connection((address, port), timeout=5) as connection:
        connection.sendall(json.dumps(request, separators=(",", ":")).encode() + b"\n")
        response_file = connection.makefile("rb")
        response = json.loads(response_file.readline())
    try:
        child.communicate(timeout=8)
    except subprocess.TimeoutExpired as error:
        child.kill()
        child.wait(timeout=3)
        raise ProbeFailure("pairing window did not close after redemption") from error
    if child.returncode != 0:
        raise ProbeFailure(f"pairing window failed ({child.returncode})")
    if response.get("status") != "paired" or not response.get("device_id"):
        raise ProbeFailure("proven pairing request was not accepted")
    if response.get("version") != 1:
        raise ProbeFailure("pairing response used an unsupported protocol version")
    hosts = response.get("hosts")
    if not isinstance(hosts, list) or len(hosts) != 1 or hosts[0].get("installed") is not True:
        raise ProbeFailure("pairing did not install on exactly the isolated laptop")
    response_fields = [nonce, response["device_id"].encode()]
    for host in hosts:
        try:
            response_fields.extend(
                [
                    host["id"].encode(),
                    host["host"].encode(),
                    str(int(host["port"])).encode(),
                    host["user"].encode(),
                    b"1" if host["installed"] else b"0",
                ]
            )
        except (KeyError, AttributeError, TypeError, ValueError) as error:
            raise ProbeFailure("pairing response host transcript was malformed") from error
    expected_response_proof_v1 = hmac.new(
        token,
        transcript(b"hmux-pairing-response-v1", response_fields),
        hashlib.sha256,
    ).digest()
    try:
        response_proof_v1 = base64.b64decode(response["proof"], validate=True)
    except (KeyError, ValueError, TypeError) as error:
        raise ProbeFailure("pairing response v1 proof was malformed") from error
    if not hmac.compare_digest(response_proof_v1, expected_response_proof_v1):
        raise ProbeFailure("pairing response v1 proof did not authenticate its host route")

    response_v2_fields = [
        str(int(response["version"])).encode(),
        nonce,
        response["device_id"].encode(),
    ]
    for host in hosts:
        try:
            response_v2_fields.extend(
                [
                    host["id"].encode(),
                    host["name"].encode(),
                    host["host"].encode(),
                    str(int(host["port"])).encode(),
                    host["user"].encode(),
                    b"1" if host["installed"] else b"0",
                ]
            )
            for optional in (host.get("failure"), host.get("host_key_fingerprint")):
                response_v2_fields.extend(
                    [
                        b"1" if optional is not None else b"0",
                        optional.encode() if optional is not None else b"",
                    ]
                )
        except (KeyError, AttributeError, TypeError, ValueError) as error:
            raise ProbeFailure("pairing response v2 transcript was malformed") from error
    expected_response_proof_v2 = hmac.new(
        token,
        transcript(b"hmux-pairing-response-v2", response_v2_fields),
        hashlib.sha256,
    ).digest()
    try:
        response_proof_v2 = base64.b64decode(response["proof_v2"], validate=True)
    except (KeyError, ValueError, TypeError) as error:
        raise ProbeFailure("pairing response v2 proof was malformed") from error
    if not hmac.compare_digest(response_proof_v2, expected_response_proof_v2):
        raise ProbeFailure("pairing response v2 proof did not authenticate its full host record")
    if hosts[0].get("host_key_fingerprint") != host_key_display:
        raise ProbeFailure("pairing response did not distribute the real sshd host key")
    paired_host = hosts[0]
    if (
        paired_host.get("host") != "127.0.0.1"
        or paired_host.get("port") != 22
        or paired_host.get("user") != account.pw_name
    ):
        raise ProbeFailure("pairing response distributed an unexpected laptop endpoint")
    authorized = authorized_keys.read_text(encoding="utf-8")
    public_key_body = " ".join(public_key.split()[:2])
    escaped_command = forced_command.replace("\\", "\\\\").replace('"', '\\"')
    expected_entry = (
        f'command="{escaped_command}",restrict {public_key_body} '
        f"hmux-pairing:{response['device_id']}"
    )
    matching_lines = [
        line
        for line in authorized.splitlines()
        if f" {public_key_body} " in f" {line} "
    ]
    if matching_lines != [expected_entry]:
        raise ProbeFailure("pairing did not install a forced-command key")

    prove_ssh_drop_and_resume(
        context,
        state,
        environment,
        identity,
        known_hosts,
        paired_host["host"],
        int(paired_host["port"]),
        paired_host["user"],
    )

    device_id = response["device_id"]
    listed = run(
        [str(context.hmux), "pair", "list"],
        environment=environment,
    )
    if device_id not in listed.stdout:
        raise ProbeFailure("paired device was absent from the artifact CLI list")
    run(
        [str(context.hmux), "pair", "revoke", device_id],
        environment=environment,
    )
    authorized_after = (
        authorized_keys.read_bytes() if authorized_keys.exists() else b""
    )
    if public_key_body.encode() in authorized_after:
        raise ProbeFailure("artifact CLI did not revoke the exact paired key")
    if authorized_after != authorized_before:
        raise ProbeFailure("pairing revoke did not restore pre-existing authorized_keys bytes")
    rescanned = run(
        ["ssh-keyscan", "-T", "5", "-t", "ed25519", paired_host["host"]],
        environment=context.environment(),
    ).stdout
    if scanned_key[1] not in rescanned:
        raise ProbeFailure("real sshd identity changed before revocation verification")
    revoked = ssh_gateway(
        environment=environment,
        identity=identity,
        known_hosts=known_hosts,
        host=paired_host["host"],
        port=int(paired_host["port"]),
        user=paired_host["user"],
    )
    try:
        revoked_stdout, _ = revoked.communicate(
            input=encode_frame("hello", hello_payload(state, None)),
            timeout=8,
        )
    except subprocess.TimeoutExpired as error:
        revoked.kill()
        revoked.communicate(timeout=3)
        raise ProbeFailure("revoked SSH credential did not fail promptly") from error
    if revoked.returncode != 255 or revoked_stdout:
        raise ProbeFailure("revoked SSH credential still reached the Hmux gateway")
    return {
        "ok": True,
        "phase": "pairing",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "provenRequestAccepted": True,
        "provenResponseAccepted": True,
        "authenticatedEndpointUsed": True,
        "realHostKeyPinned": True,
        "forcedCommandInstalled": True,
        "realSshdForcedCommand": True,
        "cursorResumeWithoutSnapshot": True,
        "revoked": True,
        "revokedCredentialRejected": True,
        "elapsedMs": monotonic_millis() - started,
    }


def activation(context: Context, installer: Path) -> dict[str, Any]:
    started = monotonic_millis()
    host_machine = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64"}.get(
        platform.machine(), "unknown"
    )
    artifact_machine = context.triple.split("-", 1)[0]
    if not installer.is_file():
        raise ProbeFailure("activation probe has no installer")
    activation_root = context.state_root / "activation"
    install_root = activation_root / "install"
    command_root = activation_root / "bin"
    environment = context.environment()
    environment.update(
        {
            "HMUX_INSTALL_ROOT": str(install_root),
            "HMUX_INSTALL_DIR": str(command_root),
            "HMUX_PREBUILT_DIR": str(context.tree),
        }
    )
    architecture_shimmed = False
    if host_machine != artifact_machine:
        if host_machine != "aarch64" or artifact_machine != "x86_64":
            raise ProbeFailure("artifact installer cannot execute on this architecture")
        # Rosetta's Linux binfmt executes the exact x86 ELF, but `uname -m`
        # still reports the ARM kernel. The production installer is correct to
        # reject that ambiguous host. This probe-only shim changes only uname's
        # machine answer; every shipped x86 binary still has to execute through
        # Rosetta before the phase can pass.
        shim_directory = activation_root / "architecture-shim"
        shim_directory.mkdir(parents=True, mode=0o700)
        uname_shim = shim_directory / "uname"
        uname_shim.write_text(
            "#!/bin/sh\n"
            "case \"${1:-}\" in\n"
            "  -m) printf 'x86_64\\n' ;;\n"
            "  *) exec /usr/bin/uname \"$@\" ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        os.chmod(uname_shim, 0o700)
        environment["PATH"] = f"{shim_directory}:{environment.get('PATH', '')}"
        architecture_shimmed = True

    def installer_run(
        candidate: Path,
        *,
        print_digest: bool = False,
        expected_digest: str | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        candidate_environment = dict(environment)
        candidate_environment["HMUX_PREBUILT_DIR"] = str(candidate)
        if expected_digest is not None:
            candidate_environment["HMUX_EXPECTED_DIGEST"] = expected_digest
        command = [
            "sh",
            str(installer),
        ]
        if print_digest:
            command.append("--print-prebuilt-digest")
        return run(command, environment=candidate_environment, check=check)

    digest = run(
        ["sh", str(installer), "--print-prebuilt-digest"],
        environment=environment,
    ).stdout.strip()
    if len(digest) != 64:
        raise ProbeFailure("installer emitted no usable artifact digest")

    # This is deliberately not called a previous release: only the manifest
    # identity changes, while both executable files remain the exact current
    # artifact. It exercises immutable pointer publication and recovery, not
    # old/new binary compatibility (tracked separately by 9wbv).
    prior = activation_root / "synthetic-pointer-target"
    shutil.copytree(context.tree, prior)
    prior_manifest = prior / "install.json"
    prior_document = load_json(prior_manifest)
    prior_build_id = (
        f"prior-{hashlib.sha256(context.build_id.encode()).hexdigest()[:16]}"
    )
    prior_document["buildId"] = prior_build_id
    prior_manifest.write_text(
        json.dumps(prior_document, indent=2, separators=(",", ": ")) + "\n",
        encoding="utf-8",
    )
    prior_digest = installer_run(prior, print_digest=True).stdout.strip()
    if len(prior_digest) != 64 or prior_digest == digest:
        raise ProbeFailure("synthetic pointer target was not a distinct pinned tree")
    installer_run(prior, expected_digest=prior_digest)
    current = install_root / "current"
    if os.readlink(current) != f"versions/{prior_build_id}":
        raise ProbeFailure("synthetic pointer target was not selected")

    installer_run(context.tree, expected_digest=digest)
    updated = os.readlink(current)
    if updated != f"versions/{context.build_id}":
        raise ProbeFailure("exact artifact install did not select its immutable version")
    installed_runtime = command_root / "hmux-runtime"
    identity = parse_json_output(
        run(
            [str(installed_runtime), "--no-autostart", "hmux-build-info"],
            environment=environment,
        ),
        "installed runtime build info",
    )
    if identity.get("buildId") != context.build_id:
        raise ProbeFailure("activated runtime build ID changed")

    installer_run(prior, expected_digest=prior_digest)
    if os.readlink(current) != f"versions/{prior_build_id}":
        raise ProbeFailure("synthetic pointer rollback did not restore its target")

    corrupt = activation_root / "corrupt-candidate"
    shutil.copytree(context.tree, corrupt)
    with (corrupt / "install.json").open("a", encoding="utf-8") as file:
        file.write(" ")
    failed = installer_run(
        corrupt,
        expected_digest=digest,
        check=False,
    )
    if failed.returncode == 0:
        raise ProbeFailure("corrupt update candidate was activated")
    if os.readlink(current) != f"versions/{prior_build_id}":
        raise ProbeFailure("failed candidate moved the selected pointer")

    installer_run(context.tree, expected_digest=digest)
    if os.readlink(current) != updated:
        raise ProbeFailure("exact artifact could not reactivate after pointer rollback")
    after = parse_json_output(
        run(
            [str(installed_runtime), "--no-autostart", "hmux-build-info"],
            environment=environment,
        ),
        "rollback runtime build info",
    )
    if after.get("buildId") != context.build_id:
        raise ProbeFailure("reactivated runtime did not report the exact artifact")
    shutil.rmtree(prior)
    shutil.rmtree(corrupt)
    return {
        "ok": True,
        "phase": "activation",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "architectureShimmedForRosetta": architecture_shimmed,
        "digestPinned": True,
        "exactArtifactInstalled": True,
        "syntheticPointerSaga": True,
        "syntheticPointerRollback": True,
        "failedCandidateRejected": True,
        "failedCandidatePreservedPointer": True,
        "exactArtifactReactivated": True,
        "elapsedMs": monotonic_millis() - started,
    }


def cleanup(context: Context) -> dict[str, Any]:
    started = monotonic_millis()
    state = context.load_state()
    session = exact_session(context, state)
    if session.get("lifecycle") not in ("ready", "exited"):
        raise ProbeFailure("owned session has an unsafe lifecycle for cleanup")
    fence = json.dumps(state["fence"], separators=(",", ":"), sort_keys=True)
    run(
        context.command(
            "kill",
            state["sessionId"],
            "--expected-fence-json",
            fence,
        ),
        environment=context.environment(),
    )
    deadline = time.monotonic() + PROCESS_EXIT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not process_alive(state["hostPid"]) and not process_alive(state["providerPid"]):
            break
        time.sleep(0.05)
    if process_alive(state["hostPid"]) or process_alive(state["providerPid"]):
        raise ProbeFailure("owned Host or provider survived generation-fenced cleanup")
    shutil.rmtree(context.state_root)
    return {
        "ok": True,
        "phase": "cleanup",
        "buildId": context.build_id,
        "targetTriple": context.triple,
        "generationFenced": True,
        "hostExited": True,
        "providerExited": True,
        "elapsedMs": monotonic_millis() - started,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument(
        "phase",
        choices=(
            "prepare",
            "structured-attach",
            "resume",
            "pairing",
            "remote-client-prepare",
            "authorize-remote",
            "remote-handoff",
            "remote-state-import",
            "remote-open",
            "remote-disconnected-soak",
            "remote-marker",
            "remote-resume",
            "revoke-remote",
            "remote-rejected",
            "activation",
            "cleanup",
            "failure-cleanup",
        ),
    )
    result.add_argument("--tree", required=True)
    result.add_argument("--triple", required=True)
    result.add_argument("--state-root", required=True)
    result.add_argument("--expected-source", required=True)
    result.add_argument("--screen-reads", type=int, default=25)
    result.add_argument("--minimum-soak-seconds", type=int, default=0)
    result.add_argument("--installer")
    result.add_argument("--remote-host")
    result.add_argument("--remote-user")
    result.add_argument("--remote-public-key")
    result.add_argument("--expected-host-public-key")
    result.add_argument("--handoff-path")
    result.add_argument("--handoff-sha256")
    result.add_argument(
        "--fault-after-authorization-install",
        action="store_true",
    )
    return result


def main() -> int:
    arguments = parser().parse_args()
    try:
        context = Context(arguments)
        if arguments.phase == "prepare":
            receipt = prepare(context)
        elif arguments.phase == "structured-attach":
            receipt = structured_attach(context)
        elif arguments.phase == "resume":
            receipt = resume(
                context,
                arguments.screen_reads,
                arguments.minimum_soak_seconds,
            )
        elif arguments.phase == "pairing":
            receipt = pairing(context)
        elif arguments.phase == "remote-client-prepare":
            if not arguments.remote_host or not arguments.expected_host_public_key:
                raise ProbeFailure(
                    "remote client preparation requires a host and pinned key"
                )
            receipt = remote_client_prepare(
                context,
                arguments.remote_host,
                arguments.expected_host_public_key,
            )
        elif arguments.phase == "authorize-remote":
            if not arguments.remote_host or not arguments.remote_public_key:
                raise ProbeFailure("remote authorization requires a host and public key")
            receipt = authorize_remote_client(
                context,
                arguments.remote_public_key,
                arguments.remote_host,
                fault_after_install=arguments.fault_after_authorization_install,
            )
        elif arguments.phase == "remote-handoff":
            receipt = remote_handoff(context)
        elif arguments.phase == "remote-state-import":
            if not arguments.handoff_path or not arguments.handoff_sha256:
                raise ProbeFailure(
                    "remote state import requires a handoff and digest"
                )
            receipt = remote_state_import(
                context,
                Path(arguments.handoff_path).resolve(),
                arguments.handoff_sha256,
            )
        elif arguments.phase == "remote-open":
            if not arguments.remote_host or not arguments.remote_user:
                raise ProbeFailure("remote open requires a host and user")
            receipt = remote_client_open(
                context, arguments.remote_host, arguments.remote_user
            )
        elif arguments.phase == "remote-disconnected-soak":
            receipt = remote_disconnected_soak(
                context,
                arguments.minimum_soak_seconds,
            )
        elif arguments.phase == "remote-marker":
            receipt = remote_resume_marker(context)
        elif arguments.phase == "remote-resume":
            if not arguments.remote_host or not arguments.remote_user:
                raise ProbeFailure("remote resume requires a host and user")
            receipt = remote_client_resume(
                context, arguments.remote_host, arguments.remote_user
            )
        elif arguments.phase == "revoke-remote":
            receipt = revoke_remote_client(context)
        elif arguments.phase == "remote-rejected":
            if not arguments.remote_host or not arguments.remote_user:
                raise ProbeFailure("remote rejection requires a host and user")
            receipt = remote_client_rejected(
                context, arguments.remote_host, arguments.remote_user
            )
        elif arguments.phase == "activation":
            if not arguments.installer:
                raise ProbeFailure("activation requires --installer")
            receipt = activation(context, Path(arguments.installer).resolve())
        elif arguments.phase == "failure-cleanup":
            receipt = failure_cleanup(context)
        else:
            receipt = cleanup(context)
    except InjectedProbeFault as error:
        print(f"hmux Linux artifact probe: {error}", file=sys.stderr)
        return 86
    except ProbeFailure as error:
        print(f"hmux Linux artifact probe: {error}", file=sys.stderr)
        return 1
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
