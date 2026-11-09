import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeOpenClaudeReport } from "../../src-tauri/resources/managed-openclaude-hook.mjs";

const fence = Object.fromEntries(["WORKSPACE_ID", "SESSION_ID", "RUNNER_PRINCIPAL", "RUNNER_INSTANCE",
  "CHANNEL_EPOCH", "HOST_INSTANCE_ID", "TERMINAL_EPOCH"].map((key) => [`HMUX_${key}`, `fixture-${key}`]));
const event = (name, fields = {}) => ({ session_id: "705502bd-cc6e-41ba-9b6e-a0b1280d7fdf",
  transcript_path: "/fixture/conversation.jsonl", cwd: "/fixture", permission_mode: "default",
  hook_event_name: name, ...fields });
const privateDirectory = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dure-openclaude-hooks-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return directory;
};
const report = (name, fields, directory) => normalizeOpenClaudeReport(event(name, fields), fence, directory)?.report;

test("prompt, tool results, permission prompts and stop map to working, attention and idle", (t) => {
  const directory = privateDirectory(t);
  assert.deepEqual(
    { ...report("SessionStart", { source: "startup" }, directory), request_id: undefined },
    { request_id: undefined, identity_only: false, activity: "waiting", attention: "none", turn_completed: false },
  );
  for (const name of ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"]) {
    const working = report(name, { prompt: "Review", tool_name: "Bash" }, directory);
    assert.equal(working.activity, "working");
    assert.equal(working.attention, "none");
    assert.equal(working.working_ttl_ms, "86400000");
    assert.equal(working.turn_completed, false);
  }
  const approval = report("PermissionRequest", { tool_name: "Bash" }, directory);
  assert.equal(approval.activity, "waiting");
  assert.equal(approval.attention, "approval_required");
  assert.equal(report("PermissionRequest", { tool_name: "AskUserQuestion" }, directory).attention, "input_required");
  const done = report("Stop", { last_assistant_message: "Done" }, directory);
  assert.equal(done.activity, "waiting");
  assert.equal(done.attention, "none");
  assert.equal(done.turn_completed, true);
  assert.match(done.turn_completion_id, /^[\da-f-]{36}$/u);
  assert.equal(report("Stop", { last_assistant_message: "Done" }, directory).turn_completion_id,
    done.turn_completion_id, "a replayed stop is the same completion");
  report("UserPromptSubmit", { prompt: "Again" }, directory);
  assert.notEqual(report("Stop", {}, directory).turn_completion_id, done.turn_completion_id);
  report("UserPromptSubmit", { prompt: "Fail" }, directory);
  const failed = report("StopFailure", { error: "rate_limit" }, directory);
  assert.equal(failed.activity, "waiting");
  assert.equal(failed.attention, "error");
  assert.equal(failed.turn_completed, false);
  assert.equal(failed.turn_completion_id, undefined);
});

test("subagent tool results count only while the main turn is open", (t) => {
  const directory = privateDirectory(t);
  const child = { agent_id: "fixture-subagent", tool_name: "Bash" };
  assert.equal(report("PostToolUse", child, directory), undefined, "no turn has started");
  report("UserPromptSubmit", { prompt: "Delegate" }, directory);
  assert.equal(report("PostToolUse", child, directory).activity, "working");
  assert.equal(report("PermissionRequest", child, directory).attention, "approval_required",
    "a subagent's permission prompt still waits for the person");
  for (const name of ["UserPromptSubmit", "Stop", "StopFailure", "SessionStart"]) {
    assert.equal(report(name, child, directory), undefined, `${name} from a subagent`);
  }
  report("Stop", { last_assistant_message: "Delegated" }, directory);
  assert.equal(report("PostToolUse", child, directory), undefined, "background subagent after the turn");
  assert.equal(report("PostToolUse", { tool_name: "Bash" }, directory).activity, "working");
  assert.equal(report("SessionEnd", { reason: "exit" }, directory), undefined);
  assert.deepEqual(fs.readdirSync(directory), [], "the session's turn record is removed at exit");
  assert.equal(report("Stop", {}, directory).turn_completion_id, undefined,
    "a stop without a recorded turn still completes, without an id");
});

test("compaction, unknown, malformed and unfenced events cannot report", (t) => {
  const directory = privateDirectory(t);
  assert.equal(report("SessionStart", { source: "compact" }, directory), undefined);
  for (const name of ["Notification", "PreToolUse", "SubagentStop", "PreCompact", "Elicitation"]) {
    assert.equal(report(name, {}, directory), undefined, name);
  }
  for (const fields of [{ session_id: "" }, { session_id: "not-a-uuid" }, { session_id: 7 }]) {
    assert.equal(report("UserPromptSubmit", fields, directory), undefined);
  }
  assert.equal(normalizeOpenClaudeReport(null, fence, directory), undefined);
  for (const key of Object.keys(fence)) {
    const incomplete = { ...fence }; delete incomplete[key];
    assert.equal(normalizeOpenClaudeReport(event("UserPromptSubmit"), incomplete, directory), undefined);
  }
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "dure-openclaude-shared-"));
  t.after(() => fs.rmSync(shared, { recursive: true }));
  fs.chmodSync(shared, 0o755);
  assert.throws(() => report("UserPromptSubmit", {}, shared), /private and owned/u);
  assert.equal(fs.readdirSync(shared).length, 0);
});

test("the published hook never blocks or rewrites provider work", (t) => {
  const directory = privateDirectory(t);
  const resources = fileURLToPath(new URL("../../src-tauri/resources/", import.meta.url));
  for (const file of ["managed-openclaude-hook.mjs", "managed-hook-report.mjs"]) {
    fs.copyFileSync(path.join(resources, file), path.join(directory, file));
  }
  const hook = path.join(directory, "managed-openclaude-hook.mjs");
  for (const [environment, input] of [
    [{}, event("UserPromptSubmit")],
    [fence, event("PermissionRequest", { tool_name: "Bash" })],
    [fence, "not json"],
  ]) {
    const result = execFileSync(process.execPath, [hook], {
      env: { PATH: process.env.PATH, ...environment },
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
    });
    assert.equal(result, "{}");
  }
});
