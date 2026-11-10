import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyOpenCodeEvent, claimOpenCodeReporter, createOpenCodeActivity, managedFence, nextOpenCodeReport,
} from "../../src-tauri/resources/managed-opencode-state.mjs";

const environment = Object.fromEntries(["WORKSPACE_ID", "SESSION_ID", "RUNNER_PRINCIPAL", "RUNNER_INSTANCE",
  "CHANNEL_EPOCH", "HOST_INSTANCE_ID", "TERMINAL_EPOCH"].map((key) => [`HMUX_${key}`, `fixture-${key}`]));
const fence = managedFence(environment);
const root = "ses_root";
const child = "ses_child";

function activity() {
  const state = createOpenCodeActivity();
  nextOpenCodeReport(state, fence, false, "request-start");
  return (type, properties = {}) => {
    const completed = applyOpenCodeEvent(state, { type, properties });
    const report = nextOpenCodeReport(state, fence, completed, "request-event")?.report;
    return report && [report.activity, report.attention, report.turn_completed];
  };
}
const status = (type, sessionID = root) => ["session.status", { sessionID, status: { type } }];
const created = (id, parentID) => ["session.created", { sessionID: id, info: { id, parentID } }];

test("a turn moves through working, approval, input and a completed idle", () => {
  const send = activity();
  assert.deepEqual(send(...status("busy")), ["working", "none", false]);
  assert.equal(send(...status("busy")), undefined, "a repeated status is not a new fact");
  assert.equal(send(...status("retry")), undefined, "a retry is still the same turn");
  assert.deepEqual(send("permission.asked", { id: "per_1", sessionID: root }), ["waiting", "approval_required", false]);
  assert.deepEqual(send("permission.replied", { requestID: "per_1", reply: "once", sessionID: root }), ["working", "none", false],
    "an answered prompt stops asking for attention at once");
  assert.deepEqual(send("question.asked", { id: "que_1", sessionID: root }), ["waiting", "input_required", false]);
  assert.deepEqual(send("question.rejected", { requestID: "que_1", sessionID: root }), ["working", "none", false]);
  assert.deepEqual(send("question.asked", { id: "que_2", sessionID: root }), ["waiting", "input_required", false]);
  assert.deepEqual(send("question.replied", { requestID: "que_2", sessionID: root }), ["working", "none", false]);
  assert.deepEqual(send(...status("idle")), ["waiting", "none", true]);
  assert.equal(send(...status("idle")), undefined, "OpenCode repeats idle; one turn completes once");
});

test("an approval outranks a question and both must be answered", () => {
  const send = activity();
  send(...status("busy"));
  assert.deepEqual(send("question.asked", { id: "que_1", sessionID: root }), ["waiting", "input_required", false]);
  assert.deepEqual(send("permission.asked", { id: "per_1", sessionID: root }), ["waiting", "approval_required", false]);
  assert.deepEqual(send("permission.replied", { requestID: "per_1" }), ["waiting", "input_required", false]);
  assert.deepEqual(send("question.replied", { requestID: "que_1" }), ["working", "none", false]);
});

test("an interrupted turn goes idle without completing, a failed one asks for attention", () => {
  const send = activity();
  send(...status("busy"));
  assert.equal(send("session.error", { sessionID: root, error: { name: "MessageAbortedError" } }), undefined);
  assert.deepEqual(send(...status("idle")), ["waiting", "none", false]);
  assert.equal(send(...status("idle")), undefined);
  assert.deepEqual(send(...status("busy")), ["working", "none", false]);
  assert.deepEqual(send("session.error", { sessionID: root, error: { name: "APIError" } }), ["waiting", "error", false]);
  assert.equal(send(...status("idle")), undefined, "the failure is still what the person needs to see");
  assert.deepEqual(send(...status("busy")), ["working", "none", false], "the next turn clears it");
  assert.deepEqual(send(...status("idle")), ["waiting", "none", true], "a clean turn after a failure completes");
  assert.equal(send("session.error", { sessionID: root, error: { name: "APIError" } }), undefined,
    "an error outside a running turn is not this agent's state");
});

test("subagents run inside their parent's turn but their prompts still count", () => {
  const send = activity();
  assert.equal(send(...created(root)), undefined);
  assert.deepEqual(send(...status("busy")), ["working", "none", false]);
  assert.equal(send(...created(child, root)), undefined);
  assert.equal(send(...status("busy", child)), undefined);
  assert.deepEqual(send("permission.asked", { id: "per_1", sessionID: child }), ["waiting", "approval_required", false],
    "a subagent's prompt still waits for the person");
  assert.deepEqual(send("permission.replied", { requestID: "per_1" }), ["working", "none", false]);
  assert.equal(send("session.error", { sessionID: child, error: { name: "APIError" } }), undefined);
  assert.equal(send(...status("idle", child)), undefined, "a subagent's idle does not end the turn");
  assert.deepEqual(send(...status("idle")), ["waiting", "none", true]);
  assert.equal(send(...status("busy", child)), undefined, "a subagent after the turn cannot look busy");
});

test("two open conversations complete only when the last one is idle", () => {
  const send = activity();
  send(...status("busy", "ses_a"));
  assert.equal(send(...status("busy", "ses_b")), undefined);
  assert.equal(send(...status("idle", "ses_a")), undefined);
  assert.deepEqual(send(...status("idle", "ses_b")), ["waiting", "none", true]);
});

test("deleting a conversation drops its turn and its prompts", () => {
  const send = activity();
  send(...status("busy"));
  send("permission.asked", { id: "per_1", sessionID: root });
  assert.deepEqual(send("session.deleted", { info: { id: root } }), ["waiting", "none", false]);
});

test("only the first OpenCode in a terminal reports for it", () => {
  const launched = {};
  assert.equal(claimOpenCodeReporter(launched, 41), true);
  assert.equal(launched.DURE_OPENCODE_REPORTER_PID, "41");
  assert.equal(claimOpenCodeReporter(launched, 41), true, "a reload in the same process keeps reporting");
  assert.equal(claimOpenCodeReporter({ ...launched }, 77), false, "an OpenCode started by a tool stays quiet");
});

test("an incomplete Host fence cannot report", () => {
  assert.deepEqual(fence.session_id, "fixture-SESSION_ID");
  for (const key of Object.keys(environment)) {
    const incomplete = { ...environment };
    delete incomplete[key];
    assert.equal(managedFence(incomplete), undefined, key);
  }
  assert.equal(managedFence({ ...environment, HMUX_TERMINAL_EPOCH: "" }), undefined);
});

function publishPlugin(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dure-opencode-plugin-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const resources = fileURLToPath(new URL("../../src-tauri/resources/", import.meta.url));
  const reports = path.join(directory, "reports.jsonl");
  const fake = path.join(directory, "fake-runtime.cjs");
  fs.writeFileSync(fake, `const fs = require("node:fs");
const input = fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(reports)}, input.subarray(4).toString() + "\\n");
const body = Buffer.from(JSON.stringify({ state: "completed" }));
const frame = Buffer.alloc(4 + body.length);
frame.writeUInt32BE(body.length); body.copy(frame, 4);
process.stdout.write(frame);
`);
  const runtime = path.join(directory, "fake-runtime");
  fs.writeFileSync(runtime, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "managed-opencode-plugin.mjs"),
    fs.readFileSync(path.join(resources, "managed-opencode-plugin.mjs"), "utf8")
      .replace('"__DURE_HMUX_RUNTIME_EXECUTABLE__"', JSON.stringify(runtime)));
  for (const file of ["managed-opencode-state.mjs", "managed-hook-report.mjs"]) {
    fs.copyFileSync(path.join(resources, file), path.join(directory, file));
  }
  const read = () => fs.existsSync(reports)
    ? fs.readFileSync(reports, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { url: pathToFileURL(path.join(directory, "managed-opencode-plugin.mjs")).href, read };
}

async function eventually(check) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("the published plugin exports one plugin and delivers reports in event order", async (t) => {
  const published = publishPlugin(t);
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
  // The suite may itself run inside a Dure terminal.
  for (const key of ["DURE_OPENCODE_REPORTER_PID", ...Object.keys(environment)]) delete process.env[key];
  const module = await import(published.url);
  assert.deepEqual(Object.keys(module), ["DureOpenCodeActivity"], "OpenCode calls every export as a plugin");

  assert.deepEqual(await module.DureOpenCodeActivity({}), {}, "without a Host fence nothing is installed");
  assert.equal(process.env.DURE_OPENCODE_REPORTER_PID, undefined);

  Object.assign(process.env, environment);
  const hooks = await module.DureOpenCodeActivity({});
  await eventually(() => assert.equal(published.read().length, 1));
  await hooks.event({ event: { type: "session.status", properties: { sessionID: root, status: { type: "busy" } } } });
  await hooks.event({ event: { type: "permission.asked", properties: { id: "per_1", sessionID: root } } });
  await hooks.event({ event: { type: "permission.replied", properties: { requestID: "per_1" } } });
  await hooks.event({ event: { type: "session.status", properties: { sessionID: root, status: { type: "idle" } } } });
  await eventually(() => assert.equal(published.read().length, 5));

  const reports = published.read();
  assert.deepEqual(reports.map(({ report }) => [report.activity, report.attention, report.turn_completed]), [
    ["waiting", "none", false],
    ["working", "none", false],
    ["waiting", "approval_required", false],
    ["working", "none", false],
    ["waiting", "none", true],
  ]);
  assert.deepEqual(reports[0].expectedFence, fence);
  assert.equal(reports[1].report.working_ttl_ms, "86400000");
  assert.equal(new Set(reports.map(({ report }) => report.request_id)).size, 5);

  const reloaded = await module.DureOpenCodeActivity({});
  await reloaded.event({ event: { type: "session.status", properties: { sessionID: root, status: { type: "idle" } } } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(published.read().length, 5, "a reload neither resets the Host nor repeats a completion");

  process.env.DURE_OPENCODE_REPORTER_PID = "1";
  assert.deepEqual(await module.DureOpenCodeActivity({}), {}, "a nested OpenCode installs nothing");
});
