import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "network", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "selected", document_revision: "7" };
const lease = { resource, controller_id: "agent", epoch: "9" };
const control = { resource, controller: lease, current_page: page, next_command_sequence: "11" };
const authority = ["--controller", "agent", "--epoch", "9", "--idempotency-key", "history-once"];
const sequence = "9007199254740993";
const detail = { page, request: { sequence, url: "https://fixture/api", method: "POST", status: 201 },
  details: { headers: [{ name: "X-Request", value: "yes" }], post_data: "한글", truncated: false },
  response: { headers: [{ name: "X-Response", value: "yes" }], mime_type: "application/json", truncated: false },
  body: { data: '{"value":"한글"}', base64_encoded: false, truncated: false }, body_error: null };

function fixture(fault) {
  const calls = [];
  const run = (args) => collectBrowserCommand({ args, sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "selected" } }),
    requestBackend: async (_profile, { body, requiredCapabilities }) => {
      calls.push(body);
      assert.deepEqual(requiredCapabilities, ["browser.resource.v1", ...(args.includes("request") || args.some((value) => value.startsWith("network request ")) ? ["browser.capture.v1"] : []), "browser.network.v1"]);
      let result;
      if (body.kind === "control_state") result = fault === "lease" ? { ...control, controller: { ...lease, epoch: "10" } } : control;
      else if (body.kind === "network_state") result = { page: fault === "page" ? { ...page, document_revision: "8" } : fault === "resource" ? { ...page, resource: { ...resource, generation: "other" } } : page, requests: [], pending: 1, idle: false };
      else if (body.kind === "network_detail") result = fault === "sequence" ? { ...detail, request: { ...detail.request, sequence: "1" } } : fault === "detail-page" ? { ...detail, page: { ...page, page_id: "peer" } } : detail;
      else {
        if (fault === "lost") throw new Error("browser_response_lost");
        result = { response: { success: true, data: { cleared: true, removed: 2 } } };
      }
      return { result: { result } };
    } });
  return { run, calls };
}

test.each([
  ["network", resource.resource_id, "clear"],
  ["exec", resource.resource_id, "--command", "network requests --clear"],
  ["exec", resource.resource_id, "--command", "network requests --filter irrelevant --clear"],
])("%j clears through one admitted action without ordinary renderer observation", async (...args) => {
  const { run, calls } = fixture();
  const result = await run([...args, ...authority]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls, [{ kind: "control_state", resource_id: resource.resource_id }, { kind: "network_state", resource, page_id: page.page_id },
    { kind: "action", caller: lease.controller_id, authority: { lease, page, operation_id: "history-once", command_sequence: "11" }, action: { kind: "network_clear" } }]);
});

test("clear rejects stale authority and response identities, and never replays a lost result", async () => {
  for (const fault of ["lease", "page", "resource", "lost"]) {
    const { run, calls } = fixture(fault);
    const result = await run(["network", resource.resource_id, "clear", ...authority]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, fault === "lease" ? "browser_controller_changed" : fault === "lost" ? "browser_response_lost" : "browser_response_invalid");
    assert.equal(calls.filter((body) => body.kind === "action").length, fault === "lost" ? 1 : 0);
  }
});

test("direct and native detail preserve the exact issued sequence, metadata and body without input authority", async () => {
  for (const args of [["network", resource.resource_id, "request", sequence], ["exec", resource.resource_id, "--command", `network request ${sequence}`]]) {
    const { run, calls } = fixture();
    const result = await run([...args, "--idempotency-key", "history-once"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result, detail);
    assert.deepEqual(calls, [{ kind: "control_state", resource_id: resource.resource_id }, { kind: "network_state", resource, page_id: page.page_id }, { kind: "network_detail", page, sequence, operation_id: "history-once", export_file: false }]);
  }
});

test("detail rejects another request or page returned by the backend", async () => {
  for (const fault of ["sequence", "detail-page"]) {
    const { run, calls } = fixture(fault);
    const result = await run(["network", resource.resource_id, "request", sequence]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "browser_response_invalid");
    assert.equal(calls.length, 3);
  }
});

test("malformed history operations and native IDs never select a backend", async () => {
  const args = [
    ["network", resource.resource_id, "clear", "extra", ...authority],
    ["network", resource.resource_id, "clear", "--limit", "1", ...authority],
    ["network", resource.resource_id, "request"],
    ...["0", "01", "+1", "1.0", "18446744073709551616", "native:123.5"].map((id) => ["network", resource.resource_id, "request", id]),
    ...["network request", "network request 1 extra", "network requests --clear --backend peer", "network requests --clear --clear"].map((command) => ["exec", resource.resource_id, "--command", command]),
  ];
  for (const values of args) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: values, sourceEnvironment: {}, resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, JSON.stringify(values));
    assert.equal(contacts, 0, JSON.stringify(values));
  }
});

test("large request details use the existing immutable artifact transfer and preserve full body bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dure-network-detail-"));
  const full = { ...detail, body: { data: "한글".repeat(150_000), base64_encoded: false, truncated: false } };
  const bytes = Buffer.from(JSON.stringify(full));
  const artifact = { page, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/json", suggestedFilename: "request.json" };
  try {
    for (const fail of [false, true]) {
      const calls = [];
      const output = fail ? join(root, "missing", "request.json") : join(root, "request.json");
      const result = await collectBrowserCommand({ args: ["network", resource.resource_id, "request", sequence, "--output", output, "--idempotency-key", "detail-once"], sourceEnvironment: {},
        resolveBackend: async () => ({ profile: { id: "selected" } }),
        requestBackend: async (_profile, { body }) => {
          calls.push(body);
          if (body.kind === "control_state") return { result: { result: control } };
          if (body.kind === "network_state") return { result: { result: { page } } };
          if (body.kind === "network_detail") {
            assert.deepEqual(body, { kind: "network_detail", page, sequence, operation_id: "detail-once", export_file: true });
            return { result: { result: { page, request: detail.request, artifact } } };
          }
          assert.equal(body.kind, "artifact");
          assert.equal(body.operation_id, "detail-once");
          const chunk = bytes.subarray(body.offset, body.offset + 64 * 1024);
          return { result: { artifact, offset: body.offset, eof: body.offset + chunk.length === bytes.length, base64: chunk.toString("base64") } };
        } });
      assert.equal(result.ok, !fail, JSON.stringify(result));
      assert.equal(result.operation_id, "detail-once");
      assert.equal(calls.filter((body) => body.kind === "network_detail").length, 1);
      assert.equal(calls.some((body) => body.kind === "action"), false);
      if (!fail) assert.deepEqual(await readFile(output), bytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
