import { createHash } from "node:crypto";
import fs from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { reportManagedHook } from "./managed-hook-report.mjs";

const runtime = "__DURE_HMUX_RUNTIME_EXECUTABLE__";
const fenceKeys = ["workspace_id", "session_id", "runner_principal", "runner_instance",
  "channel_epoch", "host_instance_id", "terminal_epoch"];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function normalizeQwenReport(input, environment) {
  const fence = Object.fromEntries(fenceKeys.map((key) => [key, environment[`HMUX_${key.toUpperCase()}`]]));
  if (fenceKeys.some((key) => typeof fence[key] !== "string" || !fence[key])) return;
  // Qwen explicitly marks subagent hooks; they inherit the parent Host environment.
  if (!input || input.agent_id !== undefined || typeof input.session_id !== "string"
    || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(input.session_id)
    || typeof input.transcript_path !== "string" || !isAbsolute(input.transcript_path)
    || typeof input.timestamp !== "string" || !Number.isFinite(Date.parse(input.timestamp))) return;
  let activity = "waiting";
  let attention = "none";
  let completed = false;
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      activity = "working";
      break;
    case "Notification":
      if (input.notification_type !== "permission_prompt") return;
      attention = "approval_required";
      break;
    case "Stop":
      completed = typeof input.prompt_id === "string" && input.prompt_id.length > 0
        && typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() !== "";
      break;
    case "SessionStart":
    case "SessionEnd":
    case "StopFailure":
    case "PermissionDenied":
      break;
    default:
      return;
  }
  return {
    schema: "hmux-managed-agent-state-report-v1", schemaVersion: 1, expectedFence: fence,
    report: {
      request_id: digest([input.session_id, input.hook_event_name, input.timestamp, input.prompt_id, input.tool_use_id]),
      identity_only: false, activity, attention, turn_completed: completed,
      ...(activity === "working" ? { working_ttl_ms: "86400000" } : {}),
      ...(completed ? { turn_completion_id: digest([input.session_id, input.prompt_id]) } : {}),
      conversation_identity: { provider_id: "qwen-code", conversation_id: input.session_id },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await reportManagedHook(runtime, normalizeQwenReport, "Qwen");
}
