import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "r", generation: "g", workspace_id: "w" };
const page = { resource, page_id: "p", document_revision: "1" };
const shared = ["--controller", "agent", "--epoch", "9"];
const profile = { id: "trace-fixture", expected: { backendId: "fixture" } };

function fixture(root, fault) {
  const calls = [];
  let active = null;
  let sequence = 1;
  let closedPage = false;
  const bytes = Buffer.from(JSON.stringify({ traceEvents: [{ name: "한글 trace event" }] }));
  const manifest = { page, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/json", suggestedFilename: "/backend-path-must-not-be-written.json" };
  const run = (args) => collectBrowserCommand({ args: [...args, ...shared], cwd: root, sourceEnvironment: { DURE_HOME: root },
    resolveBackend: async () => ({ profile }), requestBackend: async (_profile, { body, requiredCapabilities }) => {
      calls.push(body);
      assert.ok(requiredCapabilities.includes("browser.tracing.v1"));
      if (body.kind === "artifact") {
        assert.ok(requiredCapabilities.includes("browser.capture.v1"));
        return { result: { artifact: { ...manifest, ...(fault === "artifact" ? { sha256: "0".repeat(64) } : {}) }, offset: 0, eof: true, base64: bytes.toString("base64") } };
      }
      let result;
      if (body.kind === "control_state") result = { resource, current_page: closedPage ? undefined : page, controller: { resource, controller_id: "agent", epoch: "9" }, next_command_sequence: String(sequence) };
      else if (body.kind === "tracing_state") result = { resource, page: fault === "page" ? { ...page, resource: { ...resource, generation: "other" } } : page, instance_id: "instance", busy: active !== null || fault === "peer", interval: fault === "peer" ? null : active };
      else if (body.kind === "tracing_intervals") {
        const primary = { resource, instance_id: "instance", busy: active !== null || fault === "peer", interval: fault === "peer" ? null : active };
        result = { resource, instances: [primary, ...(fault === "multiple" && active ? [{ ...primary, instance_id: "other-instance", interval: { ...active, operation_id: "another-start" } }] : [])] };
      }
      else if (body.kind === "action" || body.kind === "tracing_stop") {
        if (body.kind === "action") {
          assert.equal(body.action.kind, "tracing");
          assert.deepEqual(body.authority.page, page);
        } else {
          assert.equal(body.authority.page, undefined);
          assert.equal(body.authority.instance_id, "instance");
        }
        assert.equal(body.authority.command_sequence, String(sequence++));
        if (body.kind === "action") {
          assert.equal(body.action.action.kind, "start");
          assert.equal(active, null);
          active = { resource, origin: page, operation_id: body.authority.operation_id, mode: body.action.action.mode, scope: body.action.action.scope, phase: "recording", cleanup_confirmed: null };
          result = { response: { success: true, data: { started: true, interval: { ...active } } } };
          if (fault === "start") throw new Error("browser_fixture_start_reply_lost");
        } else {
          assert.equal(body.authority.recording, active.operation_id);
          const interval = { ...active, phase: "finished", cleanup_confirmed: true };
          active = null;
          result = { response: { success: true, data: { stopped: true, interval, eventCount: 1, dataLoss: false, artifact: manifest } } };
          if (fault === "stop") throw new Error("browser_fixture_stop_reply_lost");
          if (fault === "interval") result.response.data.interval = { ...interval, operation_id: "foreign" };
        }
      } else throw new Error(`unexpected ${body.kind}`);
      return { result: { result } };
    } });
  return { run, calls, bytes, closePage: () => { closedPage = true; } };
}

test("trace defaults to task scope and writes a client-local verified JSON artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-trace-cli-"));
  try {
    const { run, calls, bytes } = fixture(root);
    const started = await run(["trace", "r", "start", "--idempotency-key", "trace-start"]);
    assert.equal(started.ok, true);
    assert.equal(started.result.response.data.interval.scope, "task");
    const status = await run(["trace", "r", "status"]);
    assert.equal(status.result.interval.operation_id, "trace-start");
    const stopped = await run(["exec", "r", "--command", 'trace stop "한글 output.json"', "--idempotency-key", "trace-stop"]);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.result.path, join(root, "한글 output.json"));
    assert.deepEqual(await readFile(stopped.result.path), bytes);
    assert.deepEqual(calls.filter((row) => ["action", "tracing_stop"].includes(row.kind)).map((row) => row.kind === "action" ? row.action.action : { kind: "stop", recording: row.authority.recording }), [
      { kind: "start", mode: "trace", scope: "task" }, { kind: "stop", recording: "trace-start" },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("profiler native categories and explicit browser scope share the original interval and default destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-profiler-cli-"));
  try {
    const { run, calls, bytes } = fixture(root);
    assert.equal((await run(["exec", "r", "--command", "profiler start --categories navigation,blink.user_timing --scope browser"])).ok, true);
    const stop = await run(["profiler", "r", "stop", "--idempotency-key", "save-once"]);
    assert.equal(stop.ok, true);
    assert.equal(stop.result.response.data.interval.mode, "profiler");
    assert.ok(stop.result.path.startsWith(join(root, "browser-traces", "profiler-")));
    assert.deepEqual(await readFile(stop.result.path), bytes);
    assert.deepEqual(calls.find((row) => ["action", "tracing_stop"].includes(row.kind)).action.action.categories, ["navigation", "blink.user_timing"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stop uses retained recording authority after its page closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-trace-closed-page-"));
  try {
    const { run, calls, bytes, closePage } = fixture(root);
    assert.equal((await run(["trace", "r", "start", "--idempotency-key", "before-close"])).ok, true);
    closePage();
    const stopped = await run(["trace", "r", "stop"]);
    assert.equal(stopped.ok, true);
    assert.deepEqual(await readFile(stopped.result.path), bytes);
    const stop = calls.find((call) => call.kind === "tracing_stop");
    assert.equal(stop.authority.recording, "before-close");
    assert.equal(stop.authority.instance_id, "instance");
    assert.equal(Object.hasOwn(stop.authority, "page"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("multiple owned intervals require an exact recording and never guess a browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-trace-selection-"));
  try {
    const { run, calls, closePage } = fixture(root, "multiple");
    assert.equal((await run(["trace", "r", "start", "--idempotency-key", "first-start"])).ok, true);
    closePage();
    const ambiguous = await run(["trace", "r", "stop"]);
    assert.equal(ambiguous.error.code, "browser_trace_selection_required");
    const missing = await run(["trace", "r", "stop", "--recording", "stale-start"]);
    assert.equal(missing.error.code, "browser_trace_not_active");
    assert.equal(calls.some((call) => call.kind === "tracing_stop"), false);
    const selected = await run(["exec", "r", "--command", "trace stop --recording first-start"]);
    assert.equal(selected.ok, true);
    assert.equal(calls.filter((call) => call.kind === "tracing_stop").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const fault of ["start", "stop", "artifact", "interval"]) {
  test(`trace ${fault} failure retains its operation and never repeats a native effect`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dure-trace-fault-"));
    try {
      const { run, calls } = fixture(root, fault);
      const start = await run(["trace", "r", "start", "--idempotency-key", "start-once"]);
      if (fault === "start") {
        assert.equal(start.ok, false);assert.equal(start.operation_id, "start-once");
        assert.equal(calls.filter((row) => ["action", "tracing_stop"].includes(row.kind)).length, 1);
      } else {
        assert.equal(start.ok, true);
        const path = join(root, "existing.json");await writeFile(path, "original");
        const stop = await run(["trace", "r", "stop", "--output", path, "--idempotency-key", "stop-once"]);
        assert.equal(stop.ok, false);assert.equal(stop.operation_id, "stop-once");
        assert.equal(await readFile(path, "utf8"), "original");
        assert.equal(calls.filter((row) => ["action", "tracing_stop"].includes(row.kind)).length, 2);
        if (fault !== "stop") assert.equal(stop.result.response.data.stopped, true);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("foreign page and peer-owned capture cannot dispatch a stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-trace-authority-cli-"));
  try {
    for (const fault of ["page", "peer"]) {
      const { run, calls } = fixture(root, fault);
      const result = await run(["trace", "r", "stop", ...(fault === "page" ? ["--page", "p"] : [])]);
      assert.equal(result.ok, false);assert.equal(calls.some((row) => ["action", "tracing_stop"].includes(row.kind)), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid trace scope, categories, destinations and native routing fail before backend lookup", async () => {
  for (const args of [
    ["trace", "r", "start", "--scope", "profile"], ["trace", "r", "start", "--categories", "v8"],
    ["profiler", "r", "start", "--categories", "v8,,blink"], ["trace", "r", "start", "file.json"],
    ["trace", "r", "stop", "one.json", "--output", "two.json"], ["trace", "r", "status", "--scope", "browser"],
    ["trace", "r", "stop", "--scope", "browser"], ["trace", "r", "stop", "--output="],
    ["trace", "r", "start", "--recording", "old"], ["trace", "r", "stop", "--recording", "bad id"],
    ["trace", "r", "stop", "--recording", "old", "--page", "p"], ["snapshot", "r", "--recording", "old"],
    ["exec", "r", "--command", "trace start --backend other"], ["snapshot", "r", "--categories", "v8"],
  ]) {
    let contacted = false;
    const result = await collectBrowserCommand({ args: [...args, ...shared], resolveBackend: async () => { contacted = true; } });
    assert.equal(result.ok, false, JSON.stringify(args));assert.equal(contacted, false, JSON.stringify(args));
  }
});
