import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const page = { resource: { resource_id: "r", generation: "g", workspace_id: "w" }, page_id: "p", document_revision: "7" };
const lease = { resource: page.resource, controller_id: "agent", epoch: "9" };
const shared = ["--page", "p", "--controller", "agent", "--epoch", "9"];
const resolveBackend = async () => ({ profile: { id: "capture-test" } });

test("network limits show the latest Host-ordered requests without changing coverage or control", async () => {
  const requests = ["9007199254740993", "9007199254740994", "9007199254740995"].map((sequence) => ({ sequence, url: `https://fixture.invalid/${sequence}` }));
  const snapshot = { page, complete: false, pending: 3, idle: false, quiet_ms: null, history_truncated: true, requests };
  for (const [limit, expected] of [["1", requests.slice(2)], ["2", requests.slice(1)], ["9", requests], ["9007199254740991", requests]]) {
    const calls = [];
    const result = await collectBrowserCommand({ args: ["network", "r", "--page", "p", "--limit", limit], resolveBackend,
      requestBackend: async (_profile, request) => {
        calls.push(request.body);
        assert.deepEqual(request.requiredCapabilities, ["browser.resource.v1", "browser.network.v1"]);
        return { result: { result: request.body.kind === "observe" ? { control: { resource: page.resource, controller: null }, pages: [{ page }] } : snapshot } };
      } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result, { ...snapshot, requests: expected, truncated: expected.length < requests.length });
    assert.deepEqual(calls, [{ kind: "observe", resource_id: "r" }, { kind: "network", page }]);
    assert.equal(snapshot.requests, requests);
    assert.equal(snapshot.requests.length, 3);
    assert.equal(Object.hasOwn(snapshot, "truncated"), false);
  }
});

test("network without a limit preserves the complete existing snapshot", async () => {
  const snapshot = { page, complete: true, pending: 0, idle: true, quiet_ms: 901, history_truncated: false,
    requests: Array.from({ length: 103 }, (_, index) => ({ sequence: String(index + 1) })) };
  const result = await collectBrowserCommand({ args: ["network", "r"], resolveBackend,
    requestBackend: async (_profile, { body }) => ({ result: { result: body.kind === "observe" ? { control: { resource: page.resource, current_page: page }, pages: [{ page }] } : snapshot } }) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, snapshot);
});

test("invalid network limits and console-only cursors fail before backend resolution", async () => {
  for (const flags of [["--limit", "0"], ["--limit", "-1"], ["--limit", "1.5"], ["--limit", "01"], ["--limit", "9007199254740992"], ["--limit", "Infinity"], ["--limit", ""], ["--limit", "1", "--before", "2"]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["network", "r", ...flags], resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false);
    assert.equal(contacts, 0);
  }
});

test("network limits reject malformed snapshots and mismatched page generations", async () => {
  for (const snapshot of [{ page, requests: null }, { page: { ...page, document_revision: "8" }, requests: [] }, { page: { ...page, resource: { ...page.resource, generation: "other" } }, requests: [] }]) {
    const result = await collectBrowserCommand({ args: ["network", "r", "--page", "p", "--limit", "1"], resolveBackend,
      requestBackend: async (_profile, { body }) => ({ result: { result: body.kind === "observe" ? { control: { resource: page.resource }, pages: [{ page }] } : snapshot } }) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "browser_response_invalid");
  }
});

test("invalid capture actions and missing authority fail before contacting a backend", async () => {
  for (const args of [["unknown", ...shared], ["start", ...shared, "extra"], ["start", "--page", "p"], ["stop", ...shared, "--output", ""], ["status", ...shared, "--output", "unused"], ["start", ...shared, "--limit", "2"]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: ["capture", "r", ...args], resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false);
    assert.equal(contacts, 0);
  }
});

test("capture status reads the Host recording without a renderer probe or control", async () => {
  const calls = [];
  const result = await collectBrowserCommand({ args: ["capture", "r", "status", "--page", "p"], resolveBackend,
    requestBackend: async (_profile, request) => {
      calls.push(request.body);
      assert.deepEqual(request.requiredCapabilities, ["browser.resource.v1", "browser.network.v1"]);
      return { result: { result: request.body.kind === "control_state" ? { resource: page.resource, controller: null } : { page, recording: true, recorded: 4, complete: true } } };
    } });
  assert.equal(result.ok, true);
  assert.equal(result.result.recorded, 4);
  assert.deepEqual(calls, [{ kind: "control_state", resource_id: "r" }, { kind: "network_capture_state", resource: page.resource, page_id: "p" }]);
});

test("capture transitions use the current page and existing controller sequence", async () => {
  for (const fault of [null, "lease", "page"]) {
    const calls = [];
    const result = await collectBrowserCommand({ args: ["capture", "r", "start", ...shared, "--idempotency-key", "start-once"], resolveBackend,
      requestBackend: async (_profile, { body }) => {
        calls.push(body);
        const value = body.kind === "control_state" ? { resource: page.resource, controller: fault === "lease" ? { ...lease, epoch: "10" } : lease, next_command_sequence: "11" } : body.kind === "network_capture_state" ? { page: fault === "page" ? { ...page, page_id: "other" } : page } : { response: { success: true, data: { started: true } } };
        return { result: { result: value } };
      } });
    assert.equal(result.ok, !fault);
    if (fault) assert.equal(calls.some((call) => call.kind === "action"), false);
    else assert.deepEqual(calls[2], { kind: "action", caller: "agent", authority: { lease, page, operation_id: "start-once", command_sequence: "11" }, action: { kind: "network_capture", action: "start" } });
  }
});

test("capture stop downloads the immutable JSON artifact without stopping twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-har-artifact-"));
  try {
    const bytes = Buffer.from('{"log":{"version":"1.2","entries":[]},"text":"한글"}');
    const manifest = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/json", suggestedFilename: "capture.har" };
    const output = join(root, "capture.har");
    const calls = [];
    const result = await collectBrowserCommand({ args: ["capture", "r", "stop", ...shared, "--output", output, "--idempotency-key", "stop-once"], resolveBackend,
      requestBackend: async (_profile, { body }) => {
        calls.push(body);
        if (body.kind === "artifact") return { result: { artifact: manifest, offset: 0, base64: bytes.toString("base64"), eof: true } };
        return { result: { result: body.kind === "control_state" ? { resource: page.resource, controller: lease, next_command_sequence: "11" } : body.kind === "network_capture_state" ? { page } : { response: { success: true, data: { artifact: manifest } } } } };
      } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await readFile(output), bytes);
    assert.equal(calls.filter((call) => call.kind === "action").length, 1);
    assert.deepEqual(calls.at(-1), { kind: "artifact", operation_id: "stop-once", offset: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
