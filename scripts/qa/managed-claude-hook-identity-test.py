#!/usr/bin/env python3
"""Claude hook: a conversation identity is only reported once it can be resumed.

Claude Code hands out `session_id` at SessionStart but writes the transcript
only after the first prompt. Reporting the id before then made the IDE resume a
conversation Claude never stored (`No conversation found with session ID`).
"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HOOK = Path(__file__).resolve().parents[2] / "src-tauri/resources/managed-claude-hook.py"

spec = importlib.util.spec_from_file_location("managed_claude_hook", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

FENCE = {
    "workspaceId": "workspace-fixture",
    "sessionId": "session-fixture",
    "runnerPrincipal": "local-user",
    "runnerInstance": "runner-fixture",
    "channelEpoch": "1",
    "hostInstanceId": "host-fixture",
    "terminalEpoch": "terminal-fixture",
}


def report(native):
    request = hook.claude_report(native, FENCE)
    return None if request is None else request["report"]


class ClaudeConversationIdentityTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="claude-hook-identity-"))
        self.transcript = self.root / "fixture-conversation.jsonl"

    def test_permission_prompt_carries_its_command_and_offered_answers(self):
        result = report(
            {
                "hook_event_name": "PermissionRequest",
                "session_id": "fixture-conversation",
                "tool_name": "Bash",
                "tool_input": {"command": "cargo test", "description": "Run tests"},
                "permission_suggestions": [{"type": "addRules"}],
            }
        )
        self.assertEqual(result["activity"], "waiting")
        self.assertEqual(result["attention"], "approval_required")
        self.assertEqual(
            result["approval_request"],
            {
                "tool_name": "Bash",
                "summary": "cargo test",
                "choices": ["approve", "approve_always", "deny"],
            },
        )
        bounded = report(
            {
                "hook_event_name": "PermissionRequest",
                "session_id": "fixture-conversation",
                "tool_name": "Bash",
                "tool_input": {"command": "echo " + "\uac00" * 2000 + "\r\x1b[2J"},
            }
        )["approval_request"]
        self.assertLessEqual(len(bounded["summary"].encode("utf-8")), 2048)
        self.assertTrue(bounded["summary"].endswith("\u2026"))
        self.assertNotIn("\x1b", bounded["summary"])
        self.assertEqual(bounded["choices"], ["approve", "deny"])

    def test_prompts_that_are_not_plain_approvals_carry_no_request(self):
        question = report(
            {
                "hook_event_name": "PermissionRequest",
                "session_id": "fixture-conversation",
                "tool_name": "AskUserQuestion",
            }
        )
        self.assertEqual(question["attention"], "input_required")
        self.assertNotIn("approval_request", question)
        plan = report(
            {
                "hook_event_name": "PermissionRequest",
                "session_id": "fixture-conversation",
                "tool_name": "ExitPlanMode",
            }
        )
        self.assertEqual(plan["attention"], "approval_required")
        self.assertNotIn("approval_request", plan)

    def test_slimmed_permission_prompt_keeps_what_it_asks(self):
        native = {
            "hook_event_name": "PermissionRequest",
            "session_id": "fixture-conversation",
            "tool_name": "Write",
            "tool_input": {"file_path": "/fixture/notes.md", "content": "x" * 70000},
            "permission_suggestions": [{"type": "setMode"}],
        }
        slim = json.loads(hook.slim_body(native))
        self.assertEqual(slim["tool_input"], {"file_path": "/fixture/notes.md"})
        self.assertTrue(slim["permission_suggestions"])

    def test_session_start_without_transcript_reports_activity_only(self):
        native = {
            "hook_event_name": "SessionStart",
            "session_id": "fixture-conversation",
            "transcript_path": str(self.transcript),
        }
        self.assertFalse(self.transcript.exists())
        result = report(native)
        self.assertEqual(result["activity"], "waiting")
        self.assertNotIn("conversation_identity", result)

    def test_identity_appears_once_the_transcript_exists(self):
        self.transcript.write_text(json.dumps({"type": "user"}) + "\n")
        for event in ("SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"):
            native = {
                "hook_event_name": event,
                "session_id": "fixture-conversation",
                "transcript_path": str(self.transcript),
            }
            self.assertEqual(
                report(native)["conversation_identity"],
                {"provider_id": "claude", "conversation_id": "fixture-conversation"},
                event,
            )

    def test_missing_or_relative_transcript_path_never_promises_resume(self):
        for transcript_path in (None, "", "relative/path.jsonl", 7):
            native = {
                "hook_event_name": "Stop",
                "session_id": "fixture-conversation",
            }
            if transcript_path is not None:
                native["transcript_path"] = transcript_path
            self.assertNotIn("conversation_identity", report(native), repr(transcript_path))

    def test_slimmed_body_keeps_the_transcript_path(self):
        native = {
            "hook_event_name": "PreToolUse",
            "session_id": "fixture-conversation",
            "tool_name": "Write",
            "transcript_path": str(self.transcript),
            "tool_input": {"content": "x" * 70_000},
        }
        slimmed = json.loads(hook.slim_body(native).decode("utf-8"))
        self.assertEqual(slimmed["transcript_path"], str(self.transcript))
        self.assertNotIn("tool_input", slimmed)

    def test_background_work_snapshot_controls_completion(self):
        cases = json.loads((Path(__file__).parent / "fixtures/claude-background-work.json").read_text())
        for case in cases:
            for slim in (False, True):
                with self.subTest(case=case["name"], slim=slim):
                    native = {
                        "session_id": "fixture-conversation",
                        "prompt_id": "fixture-parent-turn",
                        **case["input"],
                    }
                    if slim:
                        native = json.loads(hook.slim_body(native))
                    result = report(native)
                    if case["activity"] is None:
                        self.assertIsNone(result)
                        continue
                    background = case.get("background", False)
                    self.assertEqual(result["activity"], case["activity"])
                    self.assertEqual(result.get("background_work", False), background)
                    self.assertEqual(result["attention"], case["attention"])
                    self.assertEqual(result["turn_completed"], case["completed"])
                    self.assertEqual(
                        result.get("turn_completion_id"),
                        "fixture-parent-turn" if case["completed"] else None,
                    )
                    self.assertEqual(
                        result.get("working_ttl_ms"),
                        str(hook.AGENT_STATE_REPORT_MAX_WORKING_TTL_MS)
                        if case["activity"] == "working" or background else None,
                    )
                    request = hook.claude_report(native, FENCE)
                    self.assertEqual(request["schemaVersion"], 3 if background else 2)
                    # An older Host or broker gets the report it has always
                    # received: background work keeps the session working.
                    older = hook.older_host_report(request)
                    self.assertEqual(older["schemaVersion"], 2)
                    self.assertNotIn("background_work", older["report"])
                    self.assertEqual(
                        older["report"]["activity"],
                        case.get("olderHostActivity", case["activity"]),
                    )
                    if background:
                        self.assertEqual(
                            older["report"]["working_ttl_ms"],
                            str(hook.AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
                        )

    def test_native_work_identity_and_source_order_survive_report_normalization(self):
        for event in ("UserPromptSubmit", "PreToolUse", "Stop"):
            native = {
                "session_id": "fixture-conversation", "hook_event_name": event,
                "prompt_id": "fixture-parent-turn", "background_tasks": [], "session_crons": [],
            }
            request = hook.claude_report(native, FENCE)
            self.assertEqual(request["schemaVersion"], 2)
            self.assertEqual(request["report"]["causality"], {
                "sequence": str(hook.HOOK_SOURCE_SEQUENCE), "work_id": "fixture-parent-turn",
            })

    def test_a_turn_failed_at_sign_in_asks_for_a_person(self):
        # Claude Code 2.1.325, signed out or with an expired login, fires
        # SessionStart, UserPromptSubmit, then StopFailure with this error and
        # no Stop. The transcript exists by then, so the conversation resumes.
        self.transcript.write_text(json.dumps({"type": "user"}) + "\n")
        native = {
            "hook_event_name": "StopFailure",
            "session_id": "fixture-conversation",
            "prompt_id": "fixture-parent-turn",
            "transcript_path": str(self.transcript),
            "error": "authentication_failed",
            "last_assistant_message": "Not logged in · Please run /login",
        }
        for body in (native, json.loads(hook.slim_body(native))):
            result = report(body)
            self.assertEqual(result["activity"], "waiting")
            self.assertEqual(result["attention"], "input_required")
            self.assertFalse(result["turn_completed"])
            self.assertNotIn("working_ttl_ms", result)
            self.assertNotIn("turn_completion_id", result)
            self.assertEqual(
                result["conversation_identity"],
                {"provider_id": "claude", "conversation_id": "fixture-conversation"},
            )

    def test_any_other_turn_failure_ends_the_turn_with_its_error(self):
        # Claude Code 2.1.331 with the API unreachable prints "API Error:
        # Can't reach the API server ... (ENOTFOUND)" and fires SessionStart,
        # UserPromptSubmit, then StopFailure with `server_error` and no Stop.
        # The prompt is idle; the session must not stay working.
        for error in ("server_error", "rate_limit", "billing_error", "unknown", None, 7):
            native = {
                "hook_event_name": "StopFailure",
                "session_id": "fixture-conversation",
                "prompt_id": "fixture-parent-turn",
                "last_assistant_message": "API Error: Can't reach the API server",
            }
            if error is not None:
                native["error"] = error
            for body in (native, json.loads(hook.slim_body(native))):
                request = hook.claude_report(body, FENCE)
                result = request["report"]
                self.assertEqual(result["activity"], "waiting", repr(error))
                self.assertEqual(result["attention"], "error", repr(error))
                self.assertFalse(result["turn_completed"])
                self.assertNotIn("working_ttl_ms", result)
                self.assertNotIn("turn_completion_id", result)
                self.assertNotIn("background_work", result)
                self.assertEqual(result["causality"], {
                    "sequence": str(hook.HOOK_SOURCE_SEQUENCE),
                    "work_id": "fixture-parent-turn",
                })

    def test_a_limit_failure_names_its_reason(self):
        # Claude Code ends a turn refused at a limit with StopFailure and the
        # error class `rate_limit` (a capacity 429 included) or
        # `billing_error`, and no Stop. The class rides beside the error so a
        # limited account can hand the conversation to another one; any
        # other failure is a plain provider error.
        expected = {
            "rate_limit": "rate_limit",
            "billing_error": "usage_limit",
            "server_error": "provider_error",
            "unknown": "provider_error",
            None: "provider_error",
            7: "provider_error",
        }
        for error, failure in expected.items():
            native = {
                "hook_event_name": "StopFailure",
                "session_id": "fixture-conversation",
                "prompt_id": "fixture-parent-turn",
            }
            if error is not None:
                native["error"] = error
            for body in (native, json.loads(hook.slim_body(native))):
                request = hook.claude_report(body, FENCE)
                self.assertEqual(request["schemaVersion"], 2, repr(error))
                self.assertEqual(request["report"]["attention"], "error", repr(error))
                self.assertEqual(request["report"]["turn_failure"], failure, repr(error))

        sign_in = hook.claude_report({
            "hook_event_name": "StopFailure",
            "session_id": "fixture-conversation",
            "prompt_id": "fixture-parent-turn",
            "error": "authentication_failed",
        }, FENCE)["report"]
        self.assertEqual(sign_in["attention"], "input_required")
        self.assertNotIn("turn_failure", sign_in)
        self.assertIsNone(report({
            "hook_event_name": "StopFailure",
            "session_id": "fixture-conversation",
            "prompt_id": "fixture-parent-turn",
            "agent_id": "fixture-subagent",
            "error": "rate_limit",
        }))
        # Nothing else carries a failure.
        stop = report({
            "hook_event_name": "Stop", "session_id": "fixture-conversation",
            "prompt_id": "fixture-parent-turn", "background_tasks": [], "session_crons": [],
        })
        self.assertNotIn("turn_failure", stop)

    def test_a_subagent_failure_leaves_the_parent_turn_alone(self):
        for error in ("server_error", "authentication_failed"):
            self.assertIsNone(report({
                "hook_event_name": "StopFailure",
                "session_id": "fixture-conversation",
                "prompt_id": "fixture-parent-turn",
                "agent_id": "fixture-subagent",
                "error": error,
            }), error)

    def test_missing_work_identity_cannot_establish_quiescence(self):
        for prompt_id in (None, "", "invalid id", "short", 7):
            result = report({
                "session_id": "fixture-conversation", "hook_event_name": "Stop",
                "prompt_id": prompt_id, "background_tasks": [], "session_crons": [],
            })
            self.assertEqual(result["activity"], "working")
            self.assertNotIn("background_work", result)
            self.assertFalse(result["turn_completed"])
            self.assertNotIn("work_id", result["causality"])


FAKE_RUNTIME = """#!/usr/bin/env python3
import json, sys
raw = sys.stdin.buffer.read()
request = json.loads(raw[4:].decode("utf-8"))
with open({log!r}, "a") as log:
    log.write(json.dumps(request) + "\\n")
if request["schemaVersion"] > {newest}:
    response = {{"state": "refused", "payload": {{
        "code": "hmux_managed_agent_state_report_request_invalid",
        "message": "managed agent state report has an unsupported schema"}}}}
else:
    response = {{"state": "completed", "payload": "applied"}}
body = json.dumps(response).encode("utf-8")
sys.stdout.buffer.write(len(body).to_bytes(4, "big") + body)
"""


class ClaudeBackgroundWorkHostCompatibilityTest(unittest.TestCase):
    """The broker embedded in the hook may predate background work reports."""

    def deliver(self, newest_schema):
        root = Path(tempfile.mkdtemp(prefix="claude-hook-broker-"))
        log = root / "requests.jsonl"
        runtime = root / "hmux-runtime"
        runtime.write_text(FAKE_RUNTIME.format(log=str(log), newest=newest_schema))
        runtime.chmod(0o700)
        native = {
            "hook_event_name": "Stop", "session_id": "fixture-conversation",
            "prompt_id": "fixture-parent-turn",
            "background_tasks": [{"type": "shell", "status": "running"}], "session_crons": [],
        }
        original = hook.HMUX_RUNTIME_EXECUTABLE
        hook.HMUX_RUNTIME_EXECUTABLE = str(runtime)
        try:
            hook.report_to_hmux("claude", native, FENCE, hook.time.monotonic() + 5)
        finally:
            hook.HMUX_RUNTIME_EXECUTABLE = original
        return [json.loads(line) for line in log.read_text().splitlines()]

    def test_current_broker_receives_the_prompt_ready_background_report(self):
        requests = self.deliver(newest_schema=3)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["schemaVersion"], 3)
        self.assertEqual(requests[0]["report"]["activity"], "waiting")
        self.assertTrue(requests[0]["report"]["background_work"])

    def test_older_broker_refusal_falls_back_to_the_working_report(self):
        requests = self.deliver(newest_schema=2)
        self.assertEqual([request["schemaVersion"] for request in requests], [3, 2])
        fallback = requests[1]["report"]
        self.assertEqual(fallback["activity"], "working")
        self.assertNotIn("background_work", fallback)
        self.assertEqual(
            fallback["working_ttl_ms"], str(hook.AGENT_STATE_REPORT_MAX_WORKING_TTL_MS)
        )
        self.assertEqual(fallback["causality"], requests[0]["report"]["causality"])


if __name__ == "__main__":
    unittest.main()
