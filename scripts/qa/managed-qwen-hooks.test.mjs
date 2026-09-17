import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareQwenExtension } from "../../src-tauri/resources/managed-qwen-extension.mjs";
import { normalizeQwenReport } from "../../src-tauri/resources/managed-qwen-hook.mjs";

const fence = Object.fromEntries(["WORKSPACE_ID", "SESSION_ID", "RUNNER_PRINCIPAL", "RUNNER_INSTANCE",
  "CHANNEL_EPOCH", "HOST_INSTANCE_ID", "TERMINAL_EPOCH"].map((key) => [`HMUX_${key}`, `fixture-${key}`]));
const event = (name, fields = {}) => ({ session_id: "905bbb07-fb59-4cde-b9ae-ed4af5368299",
  transcript_path: "/fixture/conversation.jsonl", timestamp: "2026-09-17T10:00:00.000Z",
  hook_event_name: name, prompt_id: "prompt-1", ...fields });

test("Qwen extension preserves the selected profile and stays inert outside managed launches", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-qwen-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile, { mode: 0o700 });
  const originals = {
    "settings.json": '// user hooks\n{"hooks":{"Stop":[]}}',
    "projects/history.jsonl": '{"sessionId":"untouched"}',
    "extensions/extension-enablement.json": '{"dure-lifecycle-v1":{"overrides":["!*"]}}',
  };
  for (const [relative, text] of Object.entries(originals)) {
    const file = path.join(profile, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text);
  }
  const environment = { HOME: "/untouched", QWEN_HOME: profile };
  const first = prepareQwenExtension(root, environment);
  const second = path.join(root, "second"); fs.mkdirSync(second, { mode: 0o700 });
  const next = prepareQwenExtension(second, environment);
  assert.notEqual(first, next);
  for (const [relative, text] of Object.entries(originals)) {
    assert.equal(fs.readFileSync(path.join(profile, relative), "utf8"), text);
  }
  const hooksFile = path.join(profile, "extensions/dure-lifecycle-v1/hooks/hooks.json");
  const command = JSON.parse(fs.readFileSync(hooksFile)).hooks.Stop[0].hooks[0].command;
  assert.equal(execFileSync("/bin/sh", ["-c", command], { env: {}, encoding: "utf8" }), "{}");
  for (const reporter of [first, next]) {
    fs.writeFileSync(reporter, "process.stdout.write(JSON.stringify({reporter: process.argv[1]}));");
    assert.equal(JSON.parse(execFileSync("/bin/sh", ["-c", command], {
      env: { PATH: process.env.PATH, DURE_QWEN_HOOK_PATH: reporter }, encoding: "utf8",
    })).reporter, reporter);
  }
  fs.writeFileSync(hooksFile, "user modified");
  assert.throws(() => prepareQwenExtension(root, environment), /refusing to overwrite/u);
  assert.equal(fs.readFileSync(hooksFile, "utf8"), "user modified");
});

test("provider events distinguish work, permission, tool errors and turn completion", () => {
  for (const name of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    const { report } = normalizeQwenReport(event(name), fence);
    assert.equal(report.activity, "working");
    assert.equal(report.attention, "none");
    assert.equal(report.turn_completed, false);
  }
  assert.equal(normalizeQwenReport(event("Notification", { notification_type: "permission_prompt" }), fence).report.attention, "approval_required");
  for (const name of ["PermissionDenied", "StopFailure", "SessionStart", "SessionEnd"]) {
    const { report } = normalizeQwenReport(event(name), fence);
    assert.equal(report.activity, "waiting");
    assert.equal(report.turn_completed, false);
    assert.equal(report.conversation_identity.provider_id, "qwen-code");
  }
  const first = normalizeQwenReport(event("Stop", { last_assistant_message: "Done" }), fence).report;
  const replay = normalizeQwenReport(event("Stop", { last_assistant_message: "Done", timestamp: "2026-09-17T10:00:01Z" }), fence).report;
  const next = normalizeQwenReport(event("Stop", { last_assistant_message: "Done", prompt_id: "prompt-2" }), fence).report;
  assert.equal(first.turn_completed, true);
  assert.equal(first.turn_completion_id, replay.turn_completion_id);
  assert.notEqual(first.turn_completion_id, next.turn_completion_id);
  assert.equal(normalizeQwenReport(event("Stop", { last_assistant_message: "Done", prompt_id: undefined }), fence).report.turn_completed, false);
});

test("subagent, unknown and unfenced events cannot report main activity", () => {
  for (const fields of [{ agent_id: "child" }, { session_id: "" }, { timestamp: "bad" }, { transcript_path: "relative" }]) {
    assert.equal(normalizeQwenReport(event("UserPromptSubmit", fields), fence), undefined);
  }
  assert.equal(normalizeQwenReport(event("MessageDisplay"), fence), undefined);
  for (const key of Object.keys(fence)) {
    const incomplete = { ...fence }; delete incomplete[key];
    assert.equal(normalizeQwenReport(event("UserPromptSubmit"), incomplete), undefined);
  }
});
