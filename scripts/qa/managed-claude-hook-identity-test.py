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
                    self.assertEqual(result["activity"], case["activity"])
                    self.assertEqual(result["attention"], case["attention"])
                    self.assertEqual(result["turn_completed"], case["completed"])
                    self.assertEqual(
                        result.get("turn_completion_id"),
                        "fixture-parent-turn" if case["completed"] else None,
                    )
                    self.assertEqual(
                        result.get("working_ttl_ms"),
                        str(hook.AGENT_STATE_REPORT_MAX_WORKING_TTL_MS)
                        if case["activity"] == "working" else None,
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

    def test_missing_work_identity_cannot_establish_quiescence(self):
        for prompt_id in (None, "", "invalid id", "short", 7):
            result = report({
                "session_id": "fixture-conversation", "hook_event_name": "Stop",
                "prompt_id": prompt_id, "background_tasks": [], "session_crons": [],
            })
            self.assertEqual(result["activity"], "working")
            self.assertFalse(result["turn_completed"])
            self.assertNotIn("work_id", result["causality"])


if __name__ == "__main__":
    unittest.main()
