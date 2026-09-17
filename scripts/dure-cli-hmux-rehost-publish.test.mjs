import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { agentRuntimeProjectionContext, nativeRuntimeReceipt } from "../src/test/dureAgentRuntimeFixtures.ts";
import { collectManagedRehostPreview } from "../cli/lib/managed-rehost-preview.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const operation = "agent_runtime.native_rehost.reconcile";
const cleanup = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(respond) {
  const root = mkdtempSync(join(tmpdir(), "dure-publish-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = join(root, "backend.sock");
  const calls = [];
  const result = {
    schemaVersion: 1,
    receipt: {
      schemaVersion: 1, agentId: "agent-1", operationId: "operation-1",
      selectionRevision: 2,
    },
  };
  const backend = {
    id: "fixture", generation: "generation-1", protocol: { major: 1, minor: 0 },
    capabilities: [operation, "agent_runtime.projection.inspect"], observedAtMs: Date.now(),
  };
  const server = createServer((stream) => {
    let input = "";
    stream.on("data", (chunk) => {
      input += chunk;
      if (!input.endsWith("\n")) return;
      const request = JSON.parse(input);
      calls.push(request);
      const response = respond?.(request, calls.length) ?? { result };
      if (response.drop) return stream.end();
      stream.end(`${JSON.stringify({
        schemaVersion: 1, apiVersion: "dure.backend-transport/v1",
        kind: response.error ? "dure.backend.error" : "dure.backend.response",
        requestId: request.requestId, backend, ...response,
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  chmodSync(socket, 0o600);
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(root, "backend-profiles.json"), JSON.stringify({
    schemaVersion: 1, kind: "dure.backend_profiles", profiles: [{
      id: "fixture", default: true,
      transport: { kind: "local", endpoint: { kind: "unix_socket", path: socket } },
      auth: { kind: "peer" }, trust: { kind: "local_peer" },
      expected: {
        backendId: backend.id, generation: backend.generation,
        protocol: { minimum: backend.protocol, maximum: backend.protocol },
        capabilities: backend.capabilities,
      },
      deadlineMs: 1000,
    }],
  }), { mode: 0o600 });
  const native = join(root, "hmux");
  const nativeCalls = join(root, "native-calls.jsonl");
  const installNative = ({ invalidReply = false } = {}) => writeFileSync(native, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
fs.appendFileSync(${JSON.stringify(nativeCalls)}, JSON.stringify(args) + "\\n");
const receipt = {
  schema: "hmux-managed-rehost-v1", schemaVersion: 1,
  operationId: value("--operation-id"), replayed: false,
  sourceStopReceipt: { sessionId: value("--session"), workspaceId: value("--workspace") },
  replacementReceipt: { sessionId: "successor-1", workspaceId: value("--workspace") },
};
process.stdout.write(${invalidReply} ? "lost receipt" : JSON.stringify(receipt));
`, { mode: 0o700 });
  const runCommand = async (args) => {
    try {
      return { ...await execute(process.execPath, [cli, ...args], {
        cwd: root, timeout: 10_000,
        env: {
          PATH: process.env.PATH, HOME: root, DURE_HOME: root,
          DURE_APP_CHANNEL: "stable", DURE_HMUX_BIN: native,
        },
      }), code: 0 };
    } catch (error) { return error; }
  };
  const run = (extra = []) => runCommand([
    "hmux", "rehost", "publish", "agent-1",
    "--from-session", "source-1", "--workspace", "workspace-1",
    "--operation-id", "operation-1", "--backend", "fixture", "--json", ...extra,
  ]);
  return { root, calls, result, run, runCommand, installNative,
    nativeCalls: () => existsSync(nativeCalls)
      ? readFileSync(nativeCalls, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

it("publishes and replays the original tuple without an app, registry or native executable", async () => {
  const { run, calls, result, root } = await fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await run();
    expect(output.code, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, result });
  }
  expect(calls).toHaveLength(2);
  for (const request of calls) {
    expect(request.operation).toBe(operation);
    expect(request.body).toEqual({
      schemaVersion: 1, agentId: "agent-1", operationId: "operation-1",
      sourceSessionId: "source-1", sourceWorkspaceId: "workspace-1",
    });
  }
  expect(existsSync(join(root, "server.json"))).toBe(false);
  expect(existsSync(join(root, "agents.json"))).toBe(false);
});

it("reports lost publication output separately and submits nothing until an explicit retry", async () => {
  const { run, calls } = await fixture((_request, count) => count === 1 ? { drop: true } : undefined);
  const lost = await run();
  expect(lost.code).toBe(1);
  expect(JSON.parse(lost.stderr)).toMatchObject({
    ok: false, operationId: "operation-1", agentId: "agent-1",
  });
  expect(calls).toHaveLength(1);
  const retry = await run();
  expect(retry.code, retry.stderr).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[1].body).toEqual(calls[0].body);
});

it.each([["--fresh"], ["--confirm-restart"], ["--credential-reference", "other"]].map((args) => [args]))(
  "refuses execution options before contacting the publication owner: %j", async (extra) => {
    const { run, calls } = await fixture();
    const output = await run(extra);
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stderr).error.code).toBe("rehost_publication_request_invalid");
    expect(calls).toEqual([]);
  },
);

it.each([
  ["agent_runtime_native_rehost_unavailable", "retry_same"],
  ["backend_busy", "retry_same"],
  ["agent_runtime_native_rehost_explicit_recovery_required", "terminal"],
])("keeps %s separate from the already executed native operation", async (code, disposition) => {
  const { run, calls } = await fixture(() => ({
    error: { code, message: "Publication refused", details: { disposition } },
  }));
  const output = await run();
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stderr)).toMatchObject({
    ok: false, publication: "unconfirmed", nativeExecution: "not_requested",
    error: { remoteCode: code, disposition },
  });
  expect(calls).toHaveLength(1);
});

it("does not report a different Agent's receipt as publication success", async () => {
  const { run } = await fixture(() => ({ result: {
    schemaVersion: 1,
    receipt: { schemaVersion: 1, agentId: "other-agent", selectionRevision: 2 },
  } }));
  const output = await run();
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stderr).error.code).toBe("rehost_publication_response_invalid");
});

const previewArgs = ["hmux", "rehost", "--name", "project/worker", "--backend", "fixture", "--json"];
const projection = () => ({
  schemaVersion: 1, state: "stable",
  receipt: nativeRuntimeReceipt({ kind: "provider_default" }),
  projectionContext: agentRuntimeProjectionContext(),
});
const projectedAgent = {
  id: "agent-1", name: "worker", displayName: "Renamed worker", project: "project",
  sessionId: "stale-session", workspaceId: "stale-workspace", provider: "stale-provider",
};
function writeRegistry(root, agents = [projectedAgent]) {
  writeFileSync(join(root, "agents.json"), JSON.stringify({ agents }), { mode: 0o600 });
}

it("executes a confirmed name through native start and publishes its original source without an app", async () => {
  const { root, calls, runCommand, installNative, nativeCalls } = await fixture((request) =>
    request.operation === "agent_runtime.projection.inspect" ? { result: projection() } : undefined);
  writeRegistry(root);
  installNative();
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code, output.stderr).toBe(0);
  const report = JSON.parse(output.stdout);
  expect(report).toMatchObject({ ok: true, nativeExecution: "completed", publication: "published" });
  expect(nativeCalls()).toEqual([[
    "managed-rehost-start", "--session", "runtime-native-1", "--workspace", "workspace-1",
    "--operation-id", report.continuation.operationId, "--confirm-restart", "--json",
  ]]);
  expect(calls.map((request) => request.operation)).toEqual(["agent_runtime.projection.inspect", operation]);
  expect(calls[1].body).toEqual({ schemaVersion: 1, agentId: "agent-1",
    operationId: report.continuation.operationId,
    sourceSessionId: "runtime-native-1", sourceWorkspaceId: "workspace-1" });
  expect(report.continuation.retry).toEqual([
    "hmux", "rehost", "retry", "runtime-native-1", "--workspace", "workspace-1",
    "--operation-id", report.continuation.operationId, "--confirm-restart", "--json",
  ]);
  expect(existsSync(join(root, "server.json"))).toBe(false);
});

it("pins the selected Agent and backend through name and profile changes during execution", async () => {
  const { root, calls, runCommand, installNative } = await fixture((request) => {
    if (request.operation !== "agent_runtime.projection.inspect") return;
    writeRegistry(root, [{ ...projectedAgent, id: "different-agent", sessionId: "other-source" }]);
    writeFileSync(join(root, "backend-profiles.json"), "changed during execution");
    return { result: projection() };
  });
  writeRegistry(root);
  installNative();
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({ agentId: "agent-1", publication: "published" });
  expect(calls[1].body.agentId).toBe("agent-1");
  expect(calls[1].body.sourceSessionId).toBe("runtime-native-1");
});

it("retains the exact operation after an uncertain native reply without publishing or retrying", async () => {
  const { root, calls, runCommand, installNative, nativeCalls } = await fixture(() => ({ result: projection() }));
  writeRegistry(root);
  installNative({ invalidReply: true });
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(nativeCalls()).toHaveLength(1);
  expect(output.code).toBe(1);
  const report = JSON.parse(output.stderr);
  expect(report).toMatchObject({ ok: false, nativeExecution: "unknown", publication: "not_requested" });
  expect(report.continuation.status).toContain(report.continuation.operationId);
  expect(report.continuation.retry).toContain(report.continuation.operationId);
  expect(calls.map((request) => request.operation)).toEqual(["agent_runtime.projection.inspect"]);
});

it("keeps native success on publication response loss and retries only the saved publication", async () => {
  let publicationAttempts = 0;
  const { root, calls, runCommand, installNative, nativeCalls } = await fixture((request) => {
    if (request.operation === "agent_runtime.projection.inspect") return { result: projection() };
    if (++publicationAttempts === 1) return { drop: true };
  });
  writeRegistry(root);
  installNative();
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code, output.stderr).toBe(0);
  const report = JSON.parse(output.stdout);
  expect(report).toMatchObject({ ok: true, nativeExecution: "completed", publication: "unconfirmed" });
  expect(report.receipt.operationId).toBe(report.continuation.operationId);
  writeRegistry(root, [{ ...projectedAgent, id: "different-agent" }]);
  const published = await runCommand(report.continuation.publish);
  expect(published.code, published.stderr).toBe(0);
  expect(calls[2].body).toEqual(calls[1].body);
  expect(nativeCalls()).toHaveLength(1);
});

it("previews a name without an app using only the backend's source, then publishes its pinned continuation", async () => {
  const { root, calls, runCommand } = await fixture((request) =>
    request.operation === "agent_runtime.projection.inspect" ? { result: projection() } : undefined);
  writeRegistry(root);
  const before = readFileSync(join(root, "agents.json"), "utf8");
  const output = await runCommand(previewArgs);
  expect(output.code, output.stderr).toBe(0);
  const preview = JSON.parse(output.stdout);
  expect(preview).toMatchObject({
    ok: true, state: "preview", agentId: "agent-1", nativeExecution: "not_requested",
    continuation: { sourceSessionId: "runtime-native-1", sourceWorkspaceId: "workspace-1" },
  });
  expect(calls.map((request) => request.operation)).toEqual(["agent_runtime.projection.inspect"]);
  expect(calls[0].body).toEqual({ schemaVersion: 1, agentId: "agent-1" });
  expect(readFileSync(join(root, "agents.json"), "utf8")).toBe(before);
  expect(existsSync(join(root, "server.json"))).toBe(false);
  const continuation = preview.continuation;
  expect(continuation.start).toEqual([
    "hmux", "rehost", "start", "runtime-native-1", "--workspace", "workspace-1",
    "--operation-id", continuation.operationId, "--confirm-restart", "--json",
  ]);
  // Name projection can now point somewhere else. A saved publication never resolves it again.
  writeRegistry(root, [{ ...projectedAgent, id: "another-agent", sessionId: "new-session" }]);
  const published = await runCommand(continuation.publish);
  expect(published.code, published.stderr).toBe(0);
  expect(calls[1].body).toEqual({
    schemaVersion: 1, agentId: "agent-1", operationId: continuation.operationId,
    sourceSessionId: "runtime-native-1", sourceWorkspaceId: "workspace-1",
  });
});

it.each([
  ["missing", []],
  ["ambiguous", [projectedAgent, { ...projectedAgent, id: "agent-2" }]],
  ["truncated", [projectedAgent, ...Array.from({ length: 512 }, (_, i) => ({ id: `agent-${i}`, name: `other-${i}` }))]],
])("keeps a %s name projection out of backend execution", async (_kind, agents) => {
  const { root, calls, runCommand } = await fixture();
  writeRegistry(root, agents);
  const output = await runCommand(previewArgs);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, nativeExecution: "not_requested" });
  expect(calls).toEqual([]);
});

it.each([
  { schemaVersion: 1, state: "unmanaged", agentId: "agent-1" },
  { ...projection(), receipt: { ...projection().receipt, authority: { interactionProfile: "structured_protocol" } } },
  { schemaVersion: 1, state: "transitioning", agentId: "agent-1", projectionContext: agentRuntimeProjectionContext(),
    operationId: "pending", stage: "source_stopped", journalRevision: 2,
    targetInteractionProfile: "native_cli", targetExecutionProfile: { kind: "provider_default" } },
  { schemaVersion: 1, state: "closed", agentId: "agent-1", operationId: "closed", stage: "committed" },
])("does not turn runtime state into native restart permission: %j", async (result) => {
  const { root, calls, runCommand } = await fixture(() => ({ result }));
  writeRegistry(root);
  const output = await runCommand(previewArgs);
  expect(output.code).toBe(1);
  const report = JSON.parse(output.stderr);
  expect(report).toMatchObject({ ok: false, nativeExecution: "not_requested", observation: result });
  expect(report.continuation).toBeUndefined();
  expect(calls.map((request) => request.operation)).toEqual(["agent_runtime.projection.inspect"]);
});

it("does not replace a lost backend inspection with the stale local source or an app request", async () => {
  const { root, calls, runCommand } = await fixture(() => ({ drop: true }));
  writeRegistry(root);
  const output = await runCommand(previewArgs);
  expect(output.code).toBe(1);
  const report = JSON.parse(output.stderr);
  expect(report).toMatchObject({ ok: false, nativeExecution: "not_requested" });
  expect(report.continuation).toBeUndefined();
  expect(calls).toHaveLength(1);
});

it.each(["Renamed worker", "project/Renamed worker", "stale-session"])(
  "shares existing name matching for %s without trusting its stored session", async (name) => {
    const { root, calls, runCommand } = await fixture(() => ({ result: projection() }));
    writeRegistry(root);
    const output = await runCommand(["hmux", "rehost", "--name", name, "--backend", "fixture", "--json"]);
    expect(output.code, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).continuation.sourceSessionId).toBe("runtime-native-1");
    expect(calls[0].body.agentId).toBe("agent-1");
  },
);

it("another name preview proposes a new attempt, not a retry of an earlier operation", async () => {
  const { root, runCommand } = await fixture(() => ({ result: projection() }));
  writeRegistry(root);
  const first = JSON.parse((await runCommand(previewArgs)).stdout);
  const second = JSON.parse((await runCommand(previewArgs)).stdout);
  expect(first.continuation.operationId).not.toBe(second.continuation.operationId);
  expect(first.nativeExecution).toBe("not_requested");
  expect(second.nativeExecution).toBe("not_requested");
});

it("does not give local execution commands for a remote backend", async () => {
  let requested = false;
  const report = await collectManagedRehostPreview({
    opts: { name: "worker", rest: ["rehost"] },
    registry: { state: "available", agents: [projectedAgent] },
    resolveBackend: async () => ({ profile: { id: "remote", transport: { kind: "ssh" } } }),
    requestBackend: async () => { requested = true; },
  });
  expect(report.error.code).toBe("rehost_preview_local_only");
  expect(report.continuation).toBeUndefined();
  expect(requested).toBe(false);
});
