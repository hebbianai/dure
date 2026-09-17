import { reportManagedHook } from "./managed-hook-report.mjs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtime = "__DURE_HMUX_RUNTIME_EXECUTABLE__";
const fenceKeys = ["workspace_id", "session_id", "runner_principal", "runner_instance",
  "channel_epoch", "host_instance_id", "terminal_epoch"];

function persistedConversation(input) {
  if (typeof input.transcript_path !== "string" || !isAbsolute(input.transcript_path)) return;
  let file;
  try {
    file = fs.openSync(input.transcript_path, "r");
    if (!fs.fstatSync(file).isFile()) return;
    const bytes = Buffer.alloc(4096);
    const length = fs.readSync(file, bytes, 0, bytes.length, 0);
    const header = JSON.parse(bytes.subarray(0, length).toString("utf8").split("\n")[0]);
    return header.sessionId === input.session_id && header.kind === "main";
  } catch {
    return;
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
}

function modelEvidence(input, fence, directory) {
  if (!directory) return { accepted: true, finished: false };
  const owner = fs.lstatSync(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o077) !== 0) {
    throw new Error("Gemini model evidence directory must be private and owned");
  }
  const key = createHash("sha256").update(JSON.stringify([fence, input.session_id])).digest("hex");
  const file = join(directory, `gemini-model-v1-${key}.json`);
  let state = { observedAt: 0, modelStartedAt: null, finished: false };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      throw new Error("Gemini model evidence must be a private regular file");
    }
    state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(state.observedAt) || typeof state.finished !== "boolean"
      || (state.modelStartedAt !== null && !Number.isFinite(state.modelStartedAt))) {
      throw new Error("Invalid Gemini model evidence");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const observedAt = Date.parse(input.timestamp);
  if (observedAt < state.observedAt) return { accepted: false, finished: false };
  switch (input.hook_event_name) {
    case "BeforeModel":
      state = { observedAt, modelStartedAt: observedAt, finished: false };
      break;
    case "SessionStart":
    case "BeforeAgent":
    case "BeforeTool":
      state = { observedAt, modelStartedAt: null, finished: false };
      break;
    case "AfterModel":
      // AfterModel also fires for partial chunks. Only an explicit model STOP
      // can qualify the later AfterAgent text as a completed response.
      if (state.modelStartedAt === null
        || !input.llm_response?.candidates?.some((candidate) => candidate.finishReason === "STOP")) {
        return { accepted: true, finished: state.finished };
      }
      state = { ...state, observedAt, finished: true };
      break;
    case "SessionEnd":
      fs.rmSync(file, { force: true });
      return { accepted: true, finished: false };
    case "AfterAgent":
      state = { ...state, observedAt };
      break;
    default:
      return { accepted: true, finished: state.finished };
  }
  const pending = join(directory, `.gemini-model-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(pending, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    fs.renameSync(pending, file);
  } finally { fs.rmSync(pending, { force: true }); }
  return { accepted: true, finished: state.finished,
    completionId: createHash("sha256").update(JSON.stringify([key, state.modelStartedAt])).digest("hex") };
}

export function normalizeGeminiReport(input, environment, directory) {
  const fence = Object.fromEntries(fenceKeys.map((key) => [key, environment[`HMUX_${key.toUpperCase()}`]]));
  if (fenceKeys.some((key) => typeof fence[key] !== "string" || !fence[key])) return;
  if (!input || typeof input.session_id !== "string"
    || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(input.session_id)
    || typeof input.timestamp !== "string" || !Number.isFinite(Date.parse(input.timestamp))) return;
  const persisted = persistedConversation(input);
  // Subagents inherit the terminal environment. Require the persisted main
  // transcript before attributing any activity or identity to this terminal.
  if (!persisted) return;
  let activity = "waiting";
  let attention = "none";
  let completed = false;
  switch (input.hook_event_name) {
    case "BeforeAgent":
    case "BeforeModel":
    case "AfterModel":
    case "BeforeTool":
    case "AfterTool":
      activity = "working";
      break;
    case "Notification":
      if (input.notification_type !== "ToolPermission") return;
      attention = "approval_required";
      break;
    case "AfterAgent":
      completed = typeof input.prompt_response === "string"
        && input.prompt_response.trim() !== "" && input.prompt_response !== "[no response text]";
      break;
    case "SessionStart":
    case "SessionEnd":
      break;
    default:
      return;
  }
  const model = modelEvidence(input, fence, directory);
  if (!model.accepted || input.hook_event_name === "AfterModel") return;
  completed &&= model.finished;
  const id = createHash("sha256").update(JSON.stringify([
    input.session_id, input.hook_event_name, input.timestamp,
  ])).digest("hex");
  return {
    schema: "hmux-managed-agent-state-report-v1", schemaVersion: 1, expectedFence: fence,
    report: {
      request_id: id, identity_only: false, activity, attention, turn_completed: completed,
      ...(activity === "working" ? { working_ttl_ms: "86400000" } : {}),
      ...(completed ? { turn_completion_id: model.completionId } : {}),
      conversation_identity: { provider_id: "gemini", conversation_id: input.session_id },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await reportManagedHook(runtime, (input, environment) =>
    normalizeGeminiReport(input, environment, dirname(fileURLToPath(import.meta.url))), "Gemini");
}
