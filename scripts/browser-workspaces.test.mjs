import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { parseBackendProfiles } from "../cli/lib/backend-profiles.mjs";
import { BACKEND_TRANSPORT_API_VERSION } from "../cli/lib/backend-transport.mjs";

const workspace = (index) => ({
  workspace_id: `workspace:${String(index).padStart(3, "0")}`,
  project_name: "한글 project",
  root_path: `/srv/tasks/한글 project/${index}`,
});

function fixture(result = { workspaces: [], next: null }) {
  const selections = [];
  const requests = [];
  return {
    selections,
    requests,
    run: (args = []) => collectBrowserCommand({
      args: ["workspaces", ...args],
      resolveBackend: async (selection) => {
        selections.push(selection);
        return { profile: { id: selection.backend ?? "default-backend" }, transportOptions: { fixture: true } };
      },
      requestBackend: async (profile, request, options) => {
        requests.push({ profile, request, options });
        return { result: { schemaVersion: 1, result } };
      },
    }),
  };
}

test("workspace discovery reads one page and resumes with the exact backend cursor", async () => {
  const firstPage = { workspaces: Array.from({ length: 128 }, (_, index) => workspace(index)), next: "workspace:127" };
  const secondPage = { workspaces: [workspace(128), workspace(129)], next: null };
  const first = fixture(firstPage);
  const firstReport = await first.run(["--json", "--idempotency-key", "workspace-read"]);
  assert.equal(firstReport.ok, true, JSON.stringify(firstReport));
  assert.deepEqual(firstReport.result, firstPage);
  assert.equal(firstReport.operation_id, "workspace-read");
  assert.deepEqual(first.selections, [{ backend: undefined, backendSpecified: false }]);
  assert.deepEqual(first.requests.map(({ request }) => request.body), [{ kind: "workspaces" }]);
  assert.deepEqual(first.requests[0].request.requiredCapabilities, ["browser.resource.v1"]);
  assert.equal(first.requests[0].request.operation, "browser.resource");
  const second = fixture(secondPage);
  const secondReport = await second.run(["--after", firstReport.result.next]);
  assert.equal(secondReport.ok, true, JSON.stringify(secondReport));
  assert.deepEqual(secondReport.result, secondPage);
  assert.deepEqual(second.requests.map(({ request }) => request.body), [{ kind: "workspaces", after: "workspace:127" }]);
  assert.equal(new Set([...firstReport.result.workspaces, ...secondReport.result.workspaces].map((row) => row.workspace_id)).size, 130);
});

test("workspace discovery preserves selected backend and opaque host path bytes", async () => {
  const rows = [
    { ...workspace(1), root_path: "/srv/remote/../opaque path" },
    { ...workspace(2), root_path: "C:\\remote\\한글 project" },
  ];
  const client = fixture({ workspaces: rows, next: null });
  const report = await client.run(["--backend", "remote", "--after", "workspace:000"]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.result.workspaces, rows);
  assert.deepEqual(client.selections, [{ backend: "remote", backendSpecified: true }]);
  assert.equal(client.requests[0].profile.id, "remote");
  assert.equal(client.requests[0].options.fixture, true);
  assert.equal(client.requests.length, 1);
});

test("an empty final workspace page stays empty without selecting or creating a browser", async () => {
  const client = fixture();
  const report = await client.run(["--after", "workspace:last"]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.result, { workspaces: [], next: null });
  assert.deepEqual(client.requests.map(({ request }) => request.body), [{ kind: "workspaces", after: "workspace:last" }]);
});

test("workspace discovery rejects malformed rows and non-progressing pages", async () => {
  for (const page of [
    null,
    {},
    { workspaces: null, next: null },
    { workspaces: [null], next: null },
    { workspaces: [workspace(1)] },
    { workspaces: [{ ...workspace(1), workspace_id: "bad id" }], next: null },
    { workspaces: [{ ...workspace(1), project_name: 4 }], next: null },
    { workspaces: [{ ...workspace(1), root_path: null }], next: null },
    { workspaces: [workspace(1), workspace(1)], next: null },
    { workspaces: [workspace(2), workspace(1)], next: null },
    { workspaces: [workspace(0)], next: null },
    { workspaces: [], next: "workspace:001" },
    { workspaces: [workspace(1)], next: "workspace:002" },
    { workspaces: [workspace(1)], next: "invalid cursor" },
    { workspaces: Array.from({ length: 129 }, (_, index) => workspace(index + 1)), next: "workspace:129" },
  ]) {
    const client = fixture(page);
    const report = await client.run(["--after", "workspace:000"]);
    assert.equal(report.ok, false, JSON.stringify(page));
    assert.equal(report.error.code, "browser_response_invalid", JSON.stringify(report));
    assert.equal(client.requests.length, 1);
    assert.equal(report.result, undefined);
  }
});

test("invalid workspace discovery arguments fail before resolving a backend", async () => {
  for (const args of [
    ["extra"], ["--after"], ["--after", ""], ["--after", "bad id"], ["--after", "a".repeat(161)],
    ["--after", "workspace:001", "--after", "workspace:002"],
    ["--workspace", "workspace:one"], ["--page", "page:one"], ["--controller", "agent"], ["--epoch", "1"],
    ["--output", "out.json"], ["--profile", "default"], ["--limit", "10"], ["--timeout", "100"],
    ["--state", "ready"], ["--format", "json"], ["--", "--after", "workspace:one"],
  ]) {
    const client = fixture();
    const report = await client.run(args);
    assert.equal(report.ok, false, JSON.stringify(args));
    assert.equal(report.error.code, "browser_command_invalid");
    assert.deepEqual(client.selections, []);
    assert.deepEqual(client.requests, []);
  }
});

test("workspace continuation cannot be silently ignored by other browser commands", async () => {
  for (const args of [["list", "--workspace", "workspace:one"], ["show", "resource:one"], ["tab", "profile", "list"]]) {
    let contacts = 0;
    const report = await collectBrowserCommand({
      args: [...args, "--after", "workspace:one"],
      resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); },
    });
    assert.equal(report.ok, false);
    assert.equal(report.error.code, "browser_command_invalid");
    assert.equal(contacts, 0);
  }
});

test("workspace backend failures remain failures without another request or browser fallback", async () => {
  let calls = 0;
  const report = await collectBrowserCommand({
    args: ["workspaces", "--backend", "remote"],
    resolveBackend: async () => ({ profile: { id: "remote" } }),
    requestBackend: async () => { calls++; throw new Error("browser_workspace_catalog_unavailable"); },
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "browser_workspace_catalog_unavailable");
  assert.equal(calls, 1);
});

test("workspace discovery uses the real local transport and rejects changed backend authority", async () => {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, "bw-"));
  assert.equal(dirname(root), base);
  const endpoint = process.platform === "win32"
    ? { kind: "windows_named_pipe", name: `\\\\.\\pipe\\dure-browser-workspaces-${randomUUID()}` }
    : { kind: "unix_socket", path: join(root, "backend.sock") };
  const profile = parseBackendProfiles(JSON.stringify({
    schemaVersion: 1,
    kind: "dure.backend_profiles",
    profiles: [{
      id: "workspace-fixture",
      transport: { kind: "local", endpoint },
      auth: { kind: "peer" },
      trust: { kind: "local_peer" },
      expected: {
        backendId: "workspace-backend", generation: "generation:one",
        protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
        capabilities: ["browser.resource.v1"],
      },
    }],
  })).profiles[0];
  const sockets = new Set();
  const errors = [];
  const requests = [];
  let mode = "valid";
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => errors.push(error));
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.endsWith("\n")) return;
      try {
        const request = JSON.parse(input);
        requests.push(request);
        socket.end(`${JSON.stringify({
          schemaVersion: 1, apiVersion: BACKEND_TRANSPORT_API_VERSION,
          kind: "dure.backend.response", requestId: request.requestId,
          backend: {
            id: profile.expected.backendId,
            generation: mode === "generation" ? "generation:other" : profile.expected.generation,
            protocol: { major: 1, minor: 0 },
            capabilities: mode === "capability" ? [] : profile.expected.capabilities,
            observedAtMs: Date.now(),
          },
          result: { schemaVersion: 1, result: { workspaces: [workspace(1)], next: null } },
        })}\n`);
      } catch (error) {
        errors.push(error);
        socket.destroy();
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.path ?? endpoint.name, resolve);
    });
    if (endpoint.path) chmodSync(endpoint.path, 0o600);
    for (const [nextMode, errorCode] of [
      ["valid", undefined],
      ["generation", "backend_transport_generation_mismatch"],
      ["capability", "backend_transport_capability_missing"],
    ]) {
      mode = nextMode;
      const report = await collectBrowserCommand({
        args: ["workspaces", "--backend", profile.id],
        resolveBackend: async () => ({ profile }),
      });
      assert.equal(report.ok, errorCode === undefined, JSON.stringify(report));
      assert.equal(report.error?.code, errorCode);
      if (errorCode === undefined) assert.deepEqual(report.result, { workspaces: [workspace(1)], next: null });
      else assert.equal(report.result, undefined);
    }
    assert.deepEqual(requests.map((request) => request.body), Array.from({ length: 3 }, () => ({ kind: "workspaces" })));
    assert.deepEqual(errors, []);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(dirname(root), base);
    rmSync(root, { recursive: true });
  }
});
