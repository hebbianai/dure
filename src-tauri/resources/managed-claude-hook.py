#!/usr/bin/env python3
"""Dure managed provider lifecycle handoff.

This script is published owner-only by Dure. It intentionally holds no Host
token. Local Claude may project through the live app channel; remote Claude and
Codex report through the exact-fenced Hmux runtime path embedded at publication,
so app/backend restarts cannot drop turn boundaries. Failures are silent and
never block the provider.
"""

import time

HOOK_STARTED_AT = time.monotonic()
# CLOCK_MONOTONIC matches the Rust companion on Unix (Python's default clock
# uses a different macOS clock). Windows monotonic_ns uses the system QPC.
# Capture once before stdin/import/discovery waits and preserve across retries.
HOOK_SOURCE_SEQUENCE = (
    time.clock_gettime_ns(time.CLOCK_MONOTONIC)
    if hasattr(time, "CLOCK_MONOTONIC")
    else time.monotonic_ns()
)

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading


CLAUDE_CAPABILITY = "managed_claude_host_report_causality_v1"
HMUX_RUNTIME_EXECUTABLE = "__DURE_HMUX_RUNTIME_EXECUTABLE__"
HMUX_AGENT_STATE_REPORT_SUBCOMMAND = "internal-hmux-managed-agent-state-report"
HMUX_AGENT_STATE_REPORT_SCHEMA = "hmux-managed-agent-state-report-v1"
HMUX_AGENT_STATE_REPORT_SCHEMA_VERSION = 1
AGENT_STATE_REPORT_MAX_WORKING_TTL_MS = 86_400_000
MAX_CANDIDATES = 32
MAX_DESCRIPTOR_BYTES = 16 * 1024
MAX_BODY_BYTES = 64 * 1024
# Native hook payloads carry tool_input, which a single Write call can push to
# megabytes. Those events must still reach the server (a Stop or Notification
# dropped for size leaves a finished turn reported as working), so read
# generously and slim oversized bodies down to the fields the server consumes.
MAX_STDIN_BYTES = 8 * 1024 * 1024
# PreToolUse only refreshes the working lease; forwarding at most once a
# minute per session keeps parallel tool-call bursts from saturating the
# shared report-rate window (and starving Stop/Notification reports).
PRE_TOOL_USE_COALESCE_SECONDS = 60
# One invocation deadline includes imports/input, goal lookup, and reporting.
TOTAL_TIMEOUT_SECONDS = 2.4
CODEX_GOAL_QUERY_TIMEOUT_SECONDS = 2.0
CODEX_GOAL_QUERY_ATTEMPTS = 3
CODEX_GOAL_QUERY_RETRY_SECONDS = 0.05
CODEX_APP_SERVER_MAX_LINE_BYTES = 64 * 1024
# Mirrors dure-app's primary_checkout_guidance contract; the script test
# compares this output with the Rust template.
PRIMARY_CHECKOUT_QUERY_TIMEOUT_SECONDS = 0.5
PRIMARY_CHECKOUT_REV_PARSE_ARGUMENTS = (
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
    "--abbrev-ref",
    "HEAD",
)
PRIMARY_CHECKOUT_SESSION_CONTEXT_TEMPLATE = "Dure: This session started in the primary checkout of the Git repository at {toplevel} (currently on {branch}). Other agents may use this checkout at the same time, so keep it on its current branch: do not switch branches, check out other commits, rebase, or reset here. For work that needs another branch, create a separate worktree, for example `git worktree add -b <branch> .worktrees/<name> <base>`, and work there. Follow a direct request from the user to change this checkout."
CODEX_KNOWN_GOAL_STATES = frozenset(
    ("blocked", "canceled", "cancelled", "complete", "completed", "paused")
)
CHANNEL_RE = re.compile(r"[a-z0-9-]{1,64}")
IDENTIFIER_RE = re.compile(r"[A-Za-z0-9._:+-]{1,256}")
FENCE_HEADERS = (
    ("X-Hebbian-Hmux-Session-Id", "HMUX_SESSION_ID"),
    ("X-Hebbian-Hmux-Workspace-Id", "HMUX_WORKSPACE_ID"),
    ("X-Hebbian-Hmux-Runner-Principal", "HMUX_RUNNER_PRINCIPAL"),
    ("X-Hebbian-Hmux-Runner-Instance", "HMUX_RUNNER_INSTANCE"),
    ("X-Hebbian-Hmux-Channel-Epoch", "HMUX_CHANNEL_EPOCH"),
    ("X-Hebbian-Hmux-Host-Instance-Id", "HMUX_HOST_INSTANCE_ID"),
    ("X-Hebbian-Hmux-Terminal-Epoch", "HMUX_TERMINAL_EPOCH"),
)

def app_root():
    """Resolve the descriptor root and whether it permits hook state writes."""
    overridden = os.environ.get("DURE_HOME", "")
    if overridden:
        return os.path.abspath(overridden), True
    canonical = os.path.abspath(os.path.expanduser("~/.dure"))
    if os.path.isdir(canonical):
        return canonical, True
    # Compatibility for an already-running hook only: this script performs
    # bounded descriptor reads and never creates or mutates legacy state.
    legacy = os.path.abspath(os.path.expanduser("~/.hebbian"))
    if os.path.isdir(legacy):
        return legacy, False
    return canonical, True


def owned_directory(path):
    try:
        metadata = os.lstat(path)
    except OSError:
        return False
    return (
        stat.S_ISDIR(metadata.st_mode)
        and not stat.S_ISLNK(metadata.st_mode)
        and (not hasattr(os, "geteuid") or metadata.st_uid == os.geteuid())
        and metadata.st_mode & 0o077 == 0
    )


def descriptor_candidates(root):
    candidates = [os.path.join(root, "server.json")]
    channels = os.path.join(root, "channels")
    if owned_directory(channels):
        try:
            entries = list(os.scandir(channels))
        except OSError:
            entries = []
        for entry in entries:
            if not CHANNEL_RE.fullmatch(entry.name) or not owned_directory(entry.path):
                continue
            candidates.append(os.path.join(entry.path, "server.json"))

    def modified_at(candidate):
        try:
            return os.lstat(candidate).st_mtime_ns
        except OSError:
            return -1

    candidates.sort(key=modified_at, reverse=True)
    return candidates[:MAX_CANDIDATES]


def read_descriptor(root, path):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor_fd = os.open(path, flags)
    except OSError:
        return None
    try:
        metadata = os.fstat(descriptor_fd)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or (hasattr(os, "geteuid") and metadata.st_uid != os.geteuid())
            or metadata.st_mode & 0o077 != 0
            or metadata.st_size > MAX_DESCRIPTOR_BYTES
        ):
            return None
        chunks = []
        remaining = MAX_DESCRIPTOR_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor_fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    except OSError:
        return None
    finally:
        os.close(descriptor_fd)
    if len(raw) > MAX_DESCRIPTOR_BYTES:
        return None
    try:
        descriptor = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(descriptor, dict):
        return None

    channel = descriptor.get("channel")
    expected_channel = "stable"
    channels_root = os.path.join(root, "channels") + os.sep
    absolute_path = os.path.abspath(path)
    if absolute_path.startswith(channels_root):
        relative = absolute_path[len(channels_root) :]
        pieces = relative.split(os.sep)
        if len(pieces) != 2 or pieces[1] != "server.json":
            return None
        expected_channel = pieces[0]
    elif absolute_path != os.path.join(root, "server.json"):
        return None
    if channel != expected_channel or not isinstance(channel, str):
        return None

    port = descriptor.get("port")
    process_id = descriptor.get("processId")
    generation = descriptor.get("generation")
    report_token = descriptor.get("reportToken")
    if (
        isinstance(port, bool)
        or not isinstance(port, int)
        or not 1 <= port <= 65535
        or isinstance(process_id, bool)
        or not isinstance(process_id, int)
        or process_id <= 0
        or not isinstance(generation, str)
        or not IDENTIFIER_RE.fullmatch(generation)
        or not isinstance(report_token, str)
        or not 1 <= len(report_token) <= 256
        or "\r" in report_token
        or "\n" in report_token
    ):
        return None
    return descriptor


def bounded_timeout(deadline, maximum):
    remaining = deadline - time.monotonic()
    if remaining <= 0.05:
        return None
    return max(0.05, min(maximum, remaining))


def ping_matches(descriptor, capability, deadline):
    import urllib.request

    timeout = bounded_timeout(deadline, 0.35)
    if timeout is None:
        return False
    request = urllib.request.Request(
        "http://127.0.0.1:{}/ping".format(descriptor["port"]),
        headers={"Authorization": "Bearer {}".format(descriptor["reportToken"])},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_DESCRIPTOR_BYTES + 1)
        if len(raw) > MAX_DESCRIPTOR_BYTES:
            return False
        ping = json.loads(raw.decode("utf-8"))
    except Exception:
        return False
    return (
        isinstance(ping, dict)
        and ping.get("ok") is True
        and ping.get("channel") == descriptor["channel"]
        and ping.get("generation") == descriptor["generation"]
        and ping.get("processId") == descriptor["processId"]
        and isinstance(ping.get("capabilities"), list)
        and capability in ping["capabilities"]
    )


def inherited_fence():
    values = {}
    for _header, environment in FENCE_HEADERS:
        value = os.environ.get(environment, "").strip()
        if environment == "HMUX_CHANNEL_EPOCH":
            if not value.isdigit() or int(value) <= 0:
                return None
            values[environment] = value
        elif not IDENTIFIER_RE.fullmatch(value):
            return None
        else:
            values[environment] = value
    return {
        "workspace_id": values["HMUX_WORKSPACE_ID"],
        "session_id": values["HMUX_SESSION_ID"],
        "runner_principal": values["HMUX_RUNNER_PRINCIPAL"],
        "runner_instance": values["HMUX_RUNNER_INSTANCE"],
        "channel_epoch": values["HMUX_CHANNEL_EPOCH"],
        "host_instance_id": values["HMUX_HOST_INSTANCE_ID"],
        "terminal_epoch": values["HMUX_TERMINAL_EPOCH"],
    }


def inherited_fence_headers(fence):
    headers = {"Content-Type": "application/json"}
    values = {
        "HMUX_SESSION_ID": fence["session_id"],
        "HMUX_WORKSPACE_ID": fence["workspace_id"],
        "HMUX_RUNNER_PRINCIPAL": fence["runner_principal"],
        "HMUX_RUNNER_INSTANCE": fence["runner_instance"],
        "HMUX_CHANNEL_EPOCH": fence["channel_epoch"],
        "HMUX_HOST_INSTANCE_ID": fence["host_instance_id"],
        "HMUX_TERMINAL_EPOCH": fence["terminal_epoch"],
    }
    for header, environment in FENCE_HEADERS:
        headers[header] = values[environment]
    return headers


def forward(descriptor, endpoint, body, headers, deadline):
    import urllib.request

    timeout = bounded_timeout(deadline, 1.5)
    if timeout is None:
        return False
    request_headers = dict(headers)
    request_headers["Authorization"] = "Bearer {}".format(descriptor["reportToken"])
    request = urllib.request.Request(
        "http://127.0.0.1:{}{}".format(descriptor["port"], endpoint),
        data=body,
        headers=request_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(MAX_DESCRIPTOR_BYTES + 1)
            return 200 <= response.status < 300
    except Exception:
        return False


def stop_exact_child(process):
    try:
        if process.stdin is not None:
            process.stdin.close()
    except Exception:
        pass
    if process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=0.2)
        except Exception:
            try:
                process.kill()
                process.wait(timeout=0.2)
            except Exception:
                pass


def kill_exact_child(process):
    try:
        process.kill()
    except Exception:
        pass


def codex_goal_lifecycle_once(executable, thread_id, deadline):
    timeout_seconds = deadline - time.monotonic()
    if timeout_seconds <= 0.05:
        return None
    try:
        process = subprocess.Popen(
            [executable, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    timeout = threading.Timer(timeout_seconds, kill_exact_child, args=(process,))
    timeout.daemon = True
    timeout.start()
    try:
        requests = [
            {
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "dure_goal_lifecycle",
                        "title": "Dure goal lifecycle",
                        "version": "1",
                    }
                },
            },
            {"method": "initialized", "params": {}},
            {
                "method": "thread/goal/get",
                "id": 2,
                "params": {"threadId": thread_id},
            },
        ]
        encoded = b"".join(
            json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
            for request in requests
        )
        if (
            len(encoded) > CODEX_APP_SERVER_MAX_LINE_BYTES
            or process.stdin is None
            or process.stdout is None
        ):
            return None
        process.stdin.write(encoded)
        process.stdin.flush()
        response = None
        for line in iter(process.stdout.readline, b""):
            if len(line) > CODEX_APP_SERVER_MAX_LINE_BYTES:
                return None
            try:
                candidate = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            if isinstance(candidate, dict) and candidate.get("id") == 2:
                response = candidate
                break
        if not isinstance(response, dict) or "error" in response:
            return None
        result = response.get("result")
        if not isinstance(result, dict):
            return None
        goal = result.get("goal")
        if goal is None:
            return "none"
        if not isinstance(goal, dict) or goal.get("threadId") != thread_id:
            return None
        status = goal.get("status")
        if status == "active":
            return "active"
        if status in CODEX_KNOWN_GOAL_STATES:
            return status
        return None
    finally:
        timeout.cancel()
        stop_exact_child(process)


# Codex notify closes one model turn, but an active Codex goal can schedule
# its successor without UserPromptSubmit. Read the provider's official goal
# API before projecting either pane idleness or a user-visible completion.
# A just-written goal can briefly be unavailable to a second app-server
# process, so converge on that authority within one bounded deadline.
def codex_goal_lifecycle(thread_id, deadline):
    if (
        not isinstance(thread_id, str)
        or not 8 <= len(thread_id) <= 256
        or not IDENTIFIER_RE.fullmatch(thread_id)
    ):
        return None
    executable = shutil.which("codex")
    if (
        not isinstance(executable, str)
        or not os.path.isabs(executable)
        or not os.path.isfile(executable)
        or not os.access(executable, os.X_OK)
    ):
        return None
    deadline = min(deadline, time.monotonic() + CODEX_GOAL_QUERY_TIMEOUT_SECONDS)
    for attempt in range(CODEX_GOAL_QUERY_ATTEMPTS):
        lifecycle = codex_goal_lifecycle_once(executable, thread_id, deadline)
        if lifecycle is not None:
            return lifecycle
        if attempt + 1 >= CODEX_GOAL_QUERY_ATTEMPTS:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0.05:
            break
        time.sleep(min(CODEX_GOAL_QUERY_RETRY_SECONDS, remaining))
    return None


def codex_report(native, fence, deadline):
    # notify is the sole completion source. Older live providers can retain a
    # managed Stop registration; it becomes a no-op when this script refreshes.
    if native.get("type") == "agent-turn-complete":
        turn_id, conversation_id = native.get("turn-id"), native.get("thread-id")
        if (
            not isinstance(turn_id, str)
            or not 8 <= len(turn_id) <= 256
            or not IDENTIFIER_RE.fullmatch(turn_id)
            or not isinstance(conversation_id, str)
            or not 8 <= len(conversation_id) <= 256
            or not IDENTIFIER_RE.fullmatch(conversation_id)
        ):
            return None
        goal_lifecycle = codex_goal_lifecycle(conversation_id, deadline)
        conversation_identity = {
            "provider_id": "codex",
            "conversation_id": conversation_id,
        }
        if goal_lifecycle == "active":
            report = {
                "request_id": turn_id,
                "identity_only": False,
                "activity": "working",
                "attention": "none",
                "turn_completed": False,
                "working_ttl_ms": str(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
                "conversation_identity": conversation_identity,
            }
        elif goal_lifecycle in ("complete", "completed", "none"):
            report = {
                "request_id": turn_id,
                "identity_only": False,
                "activity": "waiting",
                "attention": "none",
                "turn_completed": True,
                "turn_completion_id": turn_id,
                "conversation_identity": conversation_identity,
            }
        elif goal_lifecycle is None:
            # The native event proves that this turn ended, but cannot prove
            # whether an automatic goal successor exists. Leave the working state
            # without inventing a task completion or notification.
            report = {
                "request_id": turn_id,
                "identity_only": False,
                "activity": "waiting",
                "attention": "none",
                "turn_completed": False,
                "conversation_identity": conversation_identity,
            }
        else:
            report = {
                "request_id": turn_id,
                "identity_only": False,
                "activity": "waiting",
                "attention": (
                    "input_required" if goal_lifecycle == "blocked" else "none"
                ),
                "turn_completed": False,
                "conversation_identity": conversation_identity,
            }
    elif native.get("hook_event_name") == "SessionStart":
        conversation_id = native.get("session_id")
        if (
            not isinstance(conversation_id, str)
            or not 1 <= len(conversation_id) <= 256
            or not IDENTIFIER_RE.fullmatch(conversation_id)
        ):
            return None
        report = {
            "request_id": conversation_id,
            "identity_only": False,
            "activity": "waiting",
            "attention": "none",
            "turn_completed": False,
            "conversation_identity": {
                "provider_id": "codex",
                "conversation_id": conversation_id,
            },
        }
    elif native.get("hook_event_name") in ("UserPromptSubmit", "Interrupt"):
        turn_id = native.get("turn_id")
        conversation_id = native.get("session_id")
        if (
            not isinstance(turn_id, str)
            or not 8 <= len(turn_id) <= 256
            or not IDENTIFIER_RE.fullmatch(turn_id)
            or not isinstance(conversation_id, str)
            or not 1 <= len(conversation_id) <= 256
            or not IDENTIFIER_RE.fullmatch(conversation_id)
        ):
            return None
        working = native["hook_event_name"] == "UserPromptSubmit"
        # Interrupt is an idle boundary, not a successful completion. Its
        # synchronous hook needs no goal query or additional provider process.
        report = {
            "request_id": turn_id,
            "identity_only": False,
            "activity": "working" if working else "waiting",
            "attention": "none",
            "turn_completed": False,
            "conversation_identity": {
                "provider_id": "codex",
                "conversation_id": conversation_id,
            },
        }
        if working:
            report["working_ttl_ms"] = str(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS)
    else:
        return None
    return {
        "schema": HMUX_AGENT_STATE_REPORT_SCHEMA,
        "schemaVersion": HMUX_AGENT_STATE_REPORT_SCHEMA_VERSION,
        "expectedFence": fence,
        "report": report,
    }


def claude_transcript_exists(native):
    transcript_path = native.get("transcript_path")
    return (
        isinstance(transcript_path, str)
        and os.path.isabs(transcript_path)
        and os.path.isfile(transcript_path)
    )


def claude_report(native, fence):
    event = native.get("hook_event_name")
    conversation_id = native.get("session_id")
    if (
        not isinstance(conversation_id, str)
        or not 1 <= len(conversation_id) <= 256
    ):
        return None
    prompt_id = native.get("prompt_id")
    work_id = (
        prompt_id
        if isinstance(prompt_id, str)
        and 8 <= len(prompt_id) <= 256
        and IDENTIFIER_RE.fullmatch(prompt_id)
        else None
    )
    if event == "SessionStart":
        activity, attention, completed, working_ttl_ms = (
            "waiting",
            "none",
            False,
            None,
        )
    elif event in ("UserPromptSubmit", "PreToolUse"):
        # The lease is the protocol maximum, like the Codex and Pi reporters:
        # a Claude turn ends at a complete Stop snapshot, not at a timer, so a
        # single long tool call keeps the session visibly busy.
        activity, attention, completed, working_ttl_ms = (
            "working",
            "none",
            False,
            AGENT_STATE_REPORT_MAX_WORKING_TTL_MS,
        )
    elif event == "Stop":
        # Stop belongs to the parent, not necessarily its background work.
        # The provider registry must prove both no in-flight tasks and no
        # scheduled wakeups; absent/malformed evidence stays protected.
        quiescent = work_id is not None and all(
            native.get(field) == [] for field in ("background_tasks", "session_crons")
        )
        activity, attention, completed, working_ttl_ms = (
            "waiting" if quiescent else "working",
            "none",
            quiescent,
            None if quiescent else AGENT_STATE_REPORT_MAX_WORKING_TTL_MS,
        )
    elif event == "Notification" and native.get("notification_type") == "permission_prompt":
        activity, attention, completed, working_ttl_ms = (
            "waiting",
            "approval_required",
            False,
            None,
        )
    else:
        return None
    report = {
        "request_id": conversation_id,
        "identity_only": False,
        "activity": activity,
        "attention": attention,
        "turn_completed": completed,
        "causality": {"sequence": str(HOOK_SOURCE_SEQUENCE)},
    }
    if work_id is not None:
        report["causality"]["work_id"] = work_id
    # A conversation identity is a promise that `claude --resume <id>` works.
    # Claude Code hands out the session id at SessionStart but only writes the
    # transcript once a prompt lands, so a fresh session that never got a
    # prompt has an id and no conversation: resuming it exits with "No
    # conversation found". The transcript on disk is the fact the promise
    # rests on; until it exists the report carries activity only and a
    # replacement launch starts fresh instead of resuming nothing.
    if claude_transcript_exists(native):
        report["conversation_identity"] = {
            "provider_id": "claude",
            "conversation_id": conversation_id,
        }
    if working_ttl_ms is not None:
        report["working_ttl_ms"] = str(working_ttl_ms)
    if completed:
        report["turn_completion_id"] = work_id
    return {
        "schema": HMUX_AGENT_STATE_REPORT_SCHEMA,
        "schemaVersion": 2,
        "expectedFence": fence,
        "report": report,
    }


def report_to_hmux(provider_id, native, fence, deadline):
    """Return an exact Host refusal code, or None when reporting did not refuse."""
    if provider_id == "codex":
        request = codex_report(native, fence, deadline)
    elif provider_id == "claude":
        request = claude_report(native, fence)
    else:
        return None
    if request is None:
        return None
    runtime = HMUX_RUNTIME_EXECUTABLE
    if not os.path.isabs(runtime):
        return None
    try:
        payload = json.dumps(request, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_BODY_BYTES:
            return None
        frame = len(payload).to_bytes(4, "big") + payload
        timeout = bounded_timeout(deadline, TOTAL_TIMEOUT_SECONDS)
        if timeout is None:
            return None
        completed = subprocess.run(
            [runtime, "--no-autostart", HMUX_AGENT_STATE_REPORT_SUBCOMMAND],
            input=frame,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
        if completed.returncode != 0 or len(completed.stdout) < 4:
            return None
        declared = int.from_bytes(completed.stdout[:4], "big")
        if declared > MAX_DESCRIPTOR_BYTES or len(completed.stdout) != 4 + declared:
            return None
        response = json.loads(completed.stdout[4:].decode("utf-8"))
        if not isinstance(response, dict) or response.get("state") != "refused":
            return None
        failure = response.get("payload")
        if not isinstance(failure, dict):
            return None
        code = failure.get("code")
        return code if isinstance(code, str) else None
    except Exception:
        return None


def slim_body(native):
    minimal = {}
    for field in (
        "hook_event_name",
        "session_id",
        "prompt_id",
        "notification_type",
        "tool_name",
        # The app server decides the conversation identity by the transcript
        # on disk; a slimmed body must keep the path or a long turn withholds
        # the identity until Stop.
        "transcript_path",
    ):
        value = native.get(field)
        if isinstance(value, str):
            minimal[field] = value
    prompt = native.get("prompt")
    if isinstance(prompt, str):
        minimal["prompt"] = prompt[:4096]
    # Preserve explicit empty registries. Everything else may become unknown,
    # but reducing a large body must never manufacture quiescence.
    for field in ("background_tasks", "session_crons"):
        if native.get(field) == []:
            minimal[field] = []
    try:
        return json.dumps(minimal).encode("utf-8")
    except Exception:
        return None


def pre_tool_use_coalesced(root, session_id):
    stamp_dir = os.path.join(root, "hook-throttle")
    stamp = os.path.join(stamp_dir, "pretooluse-{}.stamp".format(session_id))
    now = time.time()
    try:
        if now - os.lstat(stamp).st_mtime < PRE_TOOL_USE_COALESCE_SECONDS:
            return True
    except OSError:
        pass
    try:
        os.makedirs(stamp_dir, mode=0o700, exist_ok=True)
        with os.fdopen(
            os.open(stamp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w"
        ):
            pass
    except Exception:
        pass
    return False


def absolute_git_path(path):
    # Git prints forward slashes everywhere, with a drive prefix on Windows.
    return path.startswith("/") or (
        len(path) >= 3 and path[0].isascii() and path[0].isalpha() and path[1:3] == ":/"
    )


def primary_checkout_guidance(native, deadline):
    """Return SessionStart output for a primary checkout, or None."""
    if native.get("hook_event_name") != "SessionStart":
        return None
    cwd = native.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()
    timeout = bounded_timeout(deadline, PRIMARY_CHECKOUT_QUERY_TIMEOUT_SECONDS)
    if timeout is None:
        return None
    try:
        completed = subprocess.run(
            ["git", "-C", cwd, *PRIMARY_CHECKOUT_REV_PARSE_ARGUMENTS],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
        lines = completed.stdout.decode("utf-8").splitlines()
    except Exception:
        return None
    if completed.returncode != 0 or len(lines) != 4:
        return None
    toplevel, git_dir, common_dir, head = lines
    if (
        not all(absolute_git_path(path) for path in (toplevel, git_dir, common_dir))
        or git_dir != common_dir
        or not head
    ):
        return None
    branch = "a detached HEAD" if head == "HEAD" else head
    context = PRIMARY_CHECKOUT_SESSION_CONTEXT_TEMPLATE.replace(
        "{toplevel}", toplevel
    ).replace("{branch}", branch)
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            }
        }
    )


def codex_notification():
    if len(sys.argv) < 2:
        return None
    try:
        native = json.loads(sys.argv[-1])
    except Exception:
        return None
    if not isinstance(native, dict) or native.get("type") != "agent-turn-complete":
        return None
    return native


def run_codex_user_notify():
    if "managed-codex" not in os.path.basename(sys.argv[0]) or len(sys.argv) < 3:
        return
    chain = sys.argv[1:-1]
    try:
        os.execvp(chain[0], chain + [sys.argv[-1]])
    except Exception:
        return


def main():
    deadline = HOOK_STARTED_AT + TOTAL_TIMEOUT_SECONDS
    notification = codex_notification()
    codex = "managed-codex" in os.path.basename(sys.argv[0])
    codex_notify_invocation = codex and len(sys.argv) >= 2
    if not codex and (
        len(sys.argv) < 2
        or sys.argv[1] != "claude"
        or "--managed-direct" not in sys.argv
    ):
        return
    fence = inherited_fence()
    if fence is None:
        return
    if codex_notify_invocation and notification is None:
        return
    body = (
        json.dumps(notification).encode("utf-8")
        if codex_notify_invocation
        else sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    )
    if not body or len(body) > MAX_STDIN_BYTES:
        return
    try:
        native = json.loads(body.decode("utf-8"))
    except Exception:
        return
    if not isinstance(native, dict):
        return
    guidance = primary_checkout_guidance(native, deadline)
    if guidance is not None:
        sys.stdout.write(guidance + "\n")
        sys.stdout.flush()
    if codex:
        return report_to_hmux("codex", native, fence, deadline) != "hmux_identity_mismatch"
    root, writable = app_root()
    if (
        native.get("hook_event_name") == "PreToolUse"
        and writable
        and pre_tool_use_coalesced(root, fence["session_id"])
    ):
        return
    if os.path.isabs(HMUX_RUNTIME_EXECUTABLE):
        report_to_hmux("claude", native, fence, deadline)
        return
    if len(body) > MAX_BODY_BYTES:
        body = slim_body(native)
        if body is None or len(body) > MAX_BODY_BYTES:
            return

    headers = inherited_fence_headers(fence)
    headers["X-Hebbian-Hmux-Source-Sequence"] = str(HOOK_SOURCE_SEQUENCE)
    for path in descriptor_candidates(root):
        descriptor = read_descriptor(root, path)
        if descriptor is None or not ping_matches(
            descriptor, CLAUDE_CAPABILITY, deadline
        ):
            continue
        if forward(descriptor, "/hooks/claude", body, headers, deadline):
            return


if __name__ == "__main__":
    chain_codex_user_notify = True
    try:
        chain_codex_user_notify = main() is not False
    except Exception:
        pass
    finally:
        if chain_codex_user_notify:
            run_codex_user_notify()
