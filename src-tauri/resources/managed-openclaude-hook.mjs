import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportManagedHook } from "./managed-hook-report.mjs";

const runtime = "__DURE_HMUX_RUNTIME_EXECUTABLE__";
const fenceKeys = ["workspace_id", "session_id", "runner_principal", "runner_instance",
  "channel_epoch", "host_instance_id", "terminal_epoch"];
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// One private record per provider generation and conversation: whether its
// main turn is open, and that turn's id. Subagents inherit the terminal
// environment, so only an open main turn lets their tool results count as
// this agent's work; a subagent that outlives its turn is background work.
function turnRecord(directory, fence, sessionId) {
  if (!directory) return;
  const owner = fs.lstatSync(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o077) !== 0) {
    throw new Error("OpenClaude turn directory must be private and owned");
  }
  return join(directory, `openclaude-turn-v1-${digest([fence, sessionId])}.json`);
}

function readTurn(file) {
  if (!file) return;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 256) {
      throw new Error("OpenClaude turn record must be a private regular file");
    }
    const turn = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof turn.id === "string" && uuid.test(turn.id) && typeof turn.open === "boolean"
      ? turn : undefined;
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

function writeTurn(file, turn) {
  if (!file) return;
  const pending = join(dirname(file), `.openclaude-turn-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(pending, JSON.stringify(turn), { flag: "wx", mode: 0o600 });
    fs.renameSync(pending, file);
  } finally { fs.rmSync(pending, { force: true }); }
}

export function normalizeOpenClaudeReport(input, environment, directory) {
  const fence = Object.fromEntries(fenceKeys.map((key) => [key, environment[`HMUX_${key.toUpperCase()}`]]));
  if (fenceKeys.some((key) => typeof fence[key] !== "string" || !fence[key])) return;
  if (!input || typeof input.session_id !== "string" || !uuid.test(input.session_id)) return;
  const subagent = input.agent_id !== undefined && input.agent_id !== null;
  const record = turnRecord(directory, fence, input.session_id);
  let activity = "waiting";
  let attention = "none";
  let completionId;
  switch (input.hook_event_name) {
    case "SessionStart":
      // Compaction starts a new session record inside a running turn.
      if (subagent || input.source === "compact") return;
      break;
    case "UserPromptSubmit":
      if (subagent) return;
      activity = "working";
      writeTurn(record, { id: randomUUID(), open: true });
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
      // A tool result after a permission prompt means the turn moved on.
      if (subagent && !readTurn(record)?.open) return;
      activity = "working";
      break;
    case "PermissionRequest":
      // The question tool asks the person for an answer, not an approval.
      attention = input.tool_name === "AskUserQuestion" ? "input_required" : "approval_required";
      break;
    case "Stop":
    case "StopFailure": {
      if (subagent) return;
      const turn = readTurn(record);
      if (turn) writeTurn(record, { ...turn, open: false });
      if (input.hook_event_name === "StopFailure") attention = "error";
      // A replayed Stop keeps its turn's id, so the Host counts it once.
      else completionId = turn?.id ?? "";
      break;
    }
    case "SessionEnd":
      if (record) fs.rmSync(record, { force: true });
      return;
    default:
      return;
  }
  const completed = completionId !== undefined;
  return {
    schema: "hmux-managed-agent-state-report-v1", schemaVersion: 1, expectedFence: fence,
    report: {
      request_id: randomUUID(), identity_only: false, activity, attention, turn_completed: completed,
      ...(activity === "working" ? { working_ttl_ms: "86400000" } : {}),
      ...(completionId ? { turn_completion_id: completionId } : {}),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await reportManagedHook(runtime, (input, environment) =>
    normalizeOpenClaudeReport(input, environment, dirname(fileURLToPath(import.meta.url))), "OpenClaude");
}
