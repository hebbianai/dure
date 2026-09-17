import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareGeminiExtension } from "../../src-tauri/resources/managed-gemini-extension.mjs";
import { normalizeGeminiReport } from "../../src-tauri/resources/managed-gemini-hook.mjs";

const conversation = "905bbb07-fb59-4cde-b9ae-ed4af5368299";
const fence = Object.fromEntries(["WORKSPACE_ID", "SESSION_ID", "RUNNER_PRINCIPAL", "RUNNER_INSTANCE",
  "CHANNEL_EPOCH", "HOST_INSTANCE_ID", "TERMINAL_EPOCH"].map((key) => [`HMUX_${key}`, `fixture-${key}`]));
const event = (name, fields = {}) => ({ session_id: conversation,
  timestamp: "2026-09-14T10:00:00.000Z", hook_event_name: name, ...fields });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-gemini-hook-test-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  return root;
}

test("extension publication preserves settings, history, enablement and other extensions", (t) => {
  const root = fixture(t);
  const environment = { HOME: "/untouched-home", GEMINI_CLI_HOME: root,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(root, "system-defaults.json") };
  const originals = {
    "system-defaults.json": '// policy\n{"security":{"folderTrust":{"enabled":true}}}',
    ".gemini/settings.json": '// user hooks\n{"hooks":{"BeforeAgent":[]}}',
    ".gemini/extensions/extension-enablement.json": '{"dure-lifecycle-v1":{"overrides":["!*"]}}',
    ".gemini/extensions/user-extension/gemini-extension.json": '{"name":"user-extension","version":"1"}',
    ".gemini/tmp/history.jsonl": '{"sessionId":"untouched"}',
  };
  for (const [relative, contents] of Object.entries(originals)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, relative), contents);
  }
  const before = { ...environment };
  assert.equal(prepareGeminiExtension(root, environment), path.join(root, "managed-gemini-hook.mjs"));
  prepareGeminiExtension(root, environment);
  assert.deepEqual(environment, before);
  for (const [relative, contents] of Object.entries(originals)) {
    assert.equal(fs.readFileSync(path.join(root, relative), "utf8"), contents);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(root, ".gemini/extensions/dure-lifecycle-v1/hooks/hooks.json"))).hooks;
  assert.equal(hooks.BeforeAgent.length, 1);
  assert.equal(execFileSync("/bin/sh", ["-c", hooks.BeforeAgent[0].hooks[0].command],
    { env: { PATH: process.env.PATH }, input: "{}", encoding: "utf8" }), "{}", "ordinary Gemini has no Dure reporter");
});

test("Dure channels select their own reporter without modifying the shared extension", (t) => {
  const root = fixture(t);
  const first = path.join(root, "channel-one"); const second = path.join(root, "channel-two");
  for (const directory of [first, second]) fs.mkdirSync(directory, { mode: 0o700 });
  const environment = { HOME: root };
  const firstReporter = prepareGeminiExtension(first, environment);
  const extensionPath = path.join(root, ".gemini/extensions/dure-lifecycle-v1/hooks/hooks.json");
  const original = fs.readFileSync(extensionPath, "utf8");
  const secondReporter = prepareGeminiExtension(second, environment);
  assert.equal(fs.readFileSync(extensionPath, "utf8"), original);
  const command = JSON.parse(original).hooks.BeforeAgent[0].hooks[0].command;
  for (const [reporter, value] of [[firstReporter, "one"], [secondReporter, "two"]]) {
    fs.writeFileSync(reporter, `process.stdout.write(JSON.stringify({ channel: ${JSON.stringify(value)} }));`);
    assert.deepEqual(JSON.parse(execFileSync("/bin/sh", ["-c", command], {
      env: { PATH: process.env.PATH, DURE_GEMINI_HOOK_PATH: reporter }, encoding: "utf8",
    })), { channel: value });
  }
});

test("simultaneous first launches publish one complete extension", async (t) => {
  const root = fixture(t);
  const launches = Array.from({ length: 8 }, (_, index) => {
    const control = path.join(root, `channel-${index}`);
    fs.mkdirSync(control, { mode: 0o700 });
    fs.copyFileSync(new URL("../../src-tauri/resources/managed-hook-extension.mjs", import.meta.url), path.join(control, "managed-hook-extension.mjs"));
    const entrypoint = path.join(control, "managed-gemini-extension.mjs");
    fs.copyFileSync(new URL("../../src-tauri/resources/managed-gemini-extension.mjs", import.meta.url), entrypoint);
    return new Promise((resolve, reject) => execFile(process.execPath, [entrypoint], {
      env: { HOME: root, GEMINI_CLI_HOME: root },
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  });
  const reporters = await Promise.all(launches);
  assert.equal(new Set(reporters).size, 8);
  prepareGeminiExtension(root, { HOME: root });
  assert.deepEqual(fs.readdirSync(path.join(root, ".gemini")), ["extensions"]);
});

test("preparation refuses conflicting, symlinked or nonprivate managed artifacts", (t) => {
  const root = fixture(t);
  const environment = { HOME: root };
  prepareGeminiExtension(root, environment);
  const extension = path.join(root, ".gemini/extensions/dure-lifecycle-v1");
  const manifest = path.join(extension, "gemini-extension.json");
  const original = fs.readFileSync(manifest, "utf8");
  fs.chmodSync(manifest, 0o644);
  assert.throws(() => prepareGeminiExtension(root, environment));
  fs.chmodSync(manifest, 0o600); fs.writeFileSync(manifest, "{}");
  assert.throws(() => prepareGeminiExtension(root, environment));
  assert.equal(fs.readFileSync(manifest, "utf8"), "{}");
  fs.unlinkSync(manifest); fs.symlinkSync(path.join(root, "missing-target"), manifest);
  assert.throws(() => prepareGeminiExtension(root, environment));
  fs.unlinkSync(manifest); fs.writeFileSync(manifest, original, { mode: 0o600 });
  fs.writeFileSync(path.join(extension, "user-data"), "preserve");
  assert.throws(() => prepareGeminiExtension(root, environment));
  assert.equal(fs.readFileSync(path.join(extension, "user-data"), "utf8"), "preserve");
});

test("Gemini events preserve the Host fence and separate approvals from completion", (t) => {
  const root = fixture(t);
  const transcript = path.join(root, "main.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ sessionId: conversation, kind: "main" }) + "\n");
  const mainEvent = (name, fields) => event(name, { transcript_path: transcript, ...fields });
  const normalize = (input) => normalizeGeminiReport(input, fence, root);
  for (const name of ["BeforeAgent", "BeforeModel", "BeforeTool", "AfterTool"]) {
    const request = normalizeGeminiReport(mainEvent(name), fence);
    assert.equal(request.report.activity, "working");
    assert.equal(request.report.working_ttl_ms, "86400000");
    assert.equal(request.expectedFence.terminal_epoch, fence.HMUX_TERMINAL_EPOCH);
  }
  const blocked = normalizeGeminiReport(mainEvent("Notification", { notification_type: "ToolPermission" }), fence);
  assert.equal(blocked.report.activity, "waiting");
  assert.equal(blocked.report.attention, "approval_required");
  assert.equal(blocked.report.turn_completed, false);
  const completed = mainEvent("AfterAgent", { prompt_response: "Done" });
  assert.equal(normalize(completed).report.turn_completed, false, "text alone cannot prove completion");
  normalize(mainEvent("BeforeModel"));
  normalize(mainEvent("AfterModel", { llm_response: { candidates: [{ finishReason: "STOP" }] } }));
  const first = normalize(completed);
  assert.equal(first.report.turn_completed, true);
  assert.equal(first.report.turn_completion_id, normalize(completed).report.turn_completion_id);
  assert.equal(first.report.turn_completion_id,
    normalize({ ...completed, timestamp: "2026-09-14T10:01:00.000Z" }).report.turn_completion_id);
  assert.equal(normalizeGeminiReport(mainEvent("AfterAgent", { prompt_response: "[no response text]" }), fence).report.turn_completed, false);
});

test("partial cancellation, errors, old chunks and tool work cannot reuse a completed model", (t) => {
  const root = fixture(t);
  const transcript = path.join(root, "main.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ sessionId: conversation, kind: "main" }) + "\n");
  const normalize = (seconds, name, fields = {}, environment = fence) => normalizeGeminiReport(event(name, {
    transcript_path: transcript, timestamp: `2026-09-14T10:00:${String(seconds).padStart(2, "0")}.000Z`, ...fields,
  }), environment, root);
  const stopped = { llm_response: { candidates: [{ finishReason: "STOP" }] } };
  normalize(1, "BeforeModel");
  normalize(2, "AfterModel", { llm_response: { candidates: [{ content: { parts: ["Partial"] } }] } });
  assert.equal(normalize(3, "AfterAgent", { prompt_response: "Partial" }).report.turn_completed, false);
  normalize(4, "BeforeModel"); normalize(5, "AfterModel", stopped);
  const completed = normalize(6, "AfterAgent", { prompt_response: "Done" });
  assert.equal(completed.report.turn_completed, true);
  normalize(7, "BeforeModel");
  assert.equal(normalize(5, "AfterModel", stopped), undefined, "old model completion must be ignored");
  assert.equal(normalize(8, "AfterAgent", { prompt_response: "Partial" }).report.turn_completed, false);
  normalize(9, "BeforeModel"); normalize(10, "AfterModel", stopped); normalize(11, "BeforeTool");
  assert.equal(normalize(12, "AfterAgent", { prompt_response: "Tool cancelled" }).report.turn_completed, false);
  normalize(13, "BeforeModel"); normalize(14, "AfterModel", stopped);
  assert.equal(normalize(15, "AfterAgent", { prompt_response: "Done" },
    { ...fence, HMUX_TERMINAL_EPOCH: "another-terminal" }).report.turn_completed, false);
  const next = normalize(15, "AfterAgent", { prompt_response: "Done" });
  assert.equal(next.report.turn_completed, true);
  assert.notEqual(next.report.turn_completion_id, completed.report.turn_completion_id);
  normalize(16, "SessionEnd");
  assert.equal(normalize(17, "AfterAgent", { prompt_response: "Late" }).report.turn_completed, false);
});

test("unknown events and incomplete identity cannot report Host state", () => {
  for (const key of Object.keys(fence)) {
    const incomplete = { ...fence }; delete incomplete[key];
    assert.equal(normalizeGeminiReport(event("BeforeAgent"), incomplete), undefined);
  }
  for (const input of [event("Unrecognized"), event("Notification", { notification_type: "Info" }),
    event("BeforeAgent", { session_id: "" }), event("BeforeAgent", { timestamp: "invalid" })]) {
    assert.equal(normalizeGeminiReport(input, fence), undefined);
  }
});

test("only a persisted matching main conversation can report activity or exact resume", (t) => {
  const root = fixture(t);
  const transcript = path.join(root, "session.jsonl");
  const input = event("SessionStart", { transcript_path: transcript });
  assert.equal(normalizeGeminiReport(input, fence), undefined);
  for (const header of [{ sessionId: "wrong", kind: "main" }, { sessionId: conversation, kind: "subagent" }]) {
    fs.writeFileSync(transcript, JSON.stringify(header) + "\n");
    assert.equal(normalizeGeminiReport(input, fence), undefined);
  }
  fs.writeFileSync(transcript, JSON.stringify({ sessionId: conversation, kind: "main" }) + "\n");
  assert.deepEqual(normalizeGeminiReport(input, fence).report.conversation_identity,
    { provider_id: "gemini", conversation_id: conversation });
});


test("published entrypoints execute through a symlinked parent directory", (t) => {
  const root = fixture(t);
  const control = path.join(root, "control"); fs.mkdirSync(control, { mode: 0o700 });
  const alias = path.join(root, "alias"); fs.symlinkSync(control, alias);
  for (const file of ["managed-gemini-extension.mjs", "managed-gemini-hook.mjs", "managed-hook-extension.mjs", "managed-hook-report.mjs"]) {
    fs.copyFileSync(new URL(`../../src-tauri/resources/${file}`, import.meta.url), path.join(control, file));
  }
  const environment = { ...process.env, HOME: root, GEMINI_CLI_HOME: root };
  const selected = execFileSync(process.execPath, [path.join(alias, "managed-gemini-extension.mjs")],
    { env: environment, encoding: "utf8" });
  assert.equal(fs.realpathSync(selected), fs.realpathSync(path.join(control, "managed-gemini-hook.mjs")));
  assert.equal(execFileSync(process.execPath, [path.join(alias, "managed-gemini-hook.mjs")],
    { env: environment, input: "{}", encoding: "utf8" }), "{}");
});
