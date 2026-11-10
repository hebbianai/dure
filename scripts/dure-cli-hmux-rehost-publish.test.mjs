import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { agentRuntimeProjectionContext, nativeRuntimeReceipt } from "../src/test/dureAgentRuntimeFixtures.ts";
import {
  collectManagedRehostFinish, collectManagedRehostNamed, MANAGED_REHOST_RUNNING_EXIT_CODE, managedRecoveryExitCode,
} from "../cli/lib/managed-rehost-named.mjs";
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
    capabilities: [operation, "agent_runtime.projection.inspect", "agent_runtime.wake", "agent_runtime.transition"], observedAtMs: Date.now(),
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
  const journal = join(root, "native-journal.json");
  // A native broker over one recovery journal file, keyed by source. Like Hmux
  // it refuses a second operation for a source that already holds one.
  // busyFirst: another executor holds the operation's lock and records its completion.
  // invalidReply: the operation completes but its receipt is lost.
  const installNative = ({ invalidReply = false, busyFirst = false } = {}) => writeFileSync(native, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
fs.appendFileSync(${JSON.stringify(nativeCalls)}, JSON.stringify(args) + "\\n");
const journalPath = ${JSON.stringify(journal)};
const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : {};
const source = { sessionId: value("--session"), workspaceId: value("--workspace") };
const key = source.workspaceId + "/" + source.sessionId;
const operationId = value("--operation-id");
const entry = journal[key];
const successor = { sessionId: "successor-1", workspaceId: source.workspaceId };
const write = (body) => process.stdout.write(JSON.stringify(body));
const refuse = (code) => {
  write({ schema: "hmux-managed-rehost-v1", schemaVersion: 1, state: "refused", error: { code, message: code + ": refused" } });
  process.exitCode = 1;
};
const receipt = (replayed) => ({ schema: "hmux-managed-rehost-v1", schemaVersion: 1, operationId, replayed,
  sourceStopReceipt: source, replacementReceipt: successor });
const resolution = (fields) => write({ schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, ...fields });
if (args[0] === "managed-rehost-resolve") {
  if (!entry || (operationId && entry.operationId !== operationId)) resolution({ state: "not_found", source });
  else if (entry.state === "completed") resolution({ state: "resolved", operationIds: [entry.operationId],
    sourceGeneration: source, currentGeneration: successor });
  else resolution({ state: "retry_required", code: "hmux_managed_rehost_retry_required",
    operationId: entry.operationId, source });
} else if (args[0] === "managed-rehost-start" && entry && entry.operationId !== operationId) {
  refuse("hmux_managed_rehost_source_changed");
} else if (args[0] === "managed-rehost-start" && !entry) {
  journal[key] = { operationId, state: "completed" };
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  if (${busyFirst}) refuse("hmux_recovery_busy");
  else process.stdout.write(${invalidReply} ? "lost receipt" : JSON.stringify(receipt(false)));
} else if (!entry || entry.operationId !== operationId) {
  refuse("hmux_managed_rehost_retry_required");
} else if (entry.state !== "completed") {
  refuse("hmux_recovery_busy");
} else {
  write(receipt(true));
}
`, { mode: 0o700 });
  /** Record an operation Hmux holds for a source, as another command or the app left it. */
  const holdNative = (operationId, state, source = { sessionId: "runtime-native-1", workspaceId: "workspace-1" }) =>
    writeFileSync(journal, JSON.stringify({ [`${source.workspaceId}/${source.sessionId}`]: { operationId, state } }));
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
  return { root, calls, result, run, runCommand, installNative, holdNative,
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
/** The read-only journal lookup a native recovery makes before proposing an operation. */
const sourceLookup = ["managed-rehost-resolve", "--session", "runtime-native-1", "--workspace", "workspace-1", "--json"];
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

const dormantProjection = () => ({
  schemaVersion: 1, state: "transitioning", agentId: "agent-1",
  operationId: "sleep-operation", stage: "source_stopped", journalRevision: 3,
  targetInteractionProfile: "native_cli", targetExecutionProfile: { kind: "provider_default" },
  deferredTarget: { state: "waiting" }, projectionContext: agentRuntimeProjectionContext(),
});

it.each([false, true])("prints named dormant recovery without a native executable (confirmed: %s)", async (confirmed) => {
  const { root, calls, runCommand, nativeCalls } = await fixture((request) => ({
    result: request.operation === "agent_runtime.projection.inspect" ? dormantProjection() : projection(),
  }));
  writeRegistry(root);
  const output = await runCommand([...previewArgs.filter((arg) => arg !== "--json"),
    ...(confirmed ? ["--confirm-restart"] : [])]);
  expect(output.code, output.stderr).toBe(0);
  expect(output.stdout).toContain(confirmed ? "wake completed" : "dormant runtime");
  expect(output.stdout).toContain("Wake: dure 'runtime' 'wake' 'agent-1'");
  expect(output.stdout).toContain("'--expected-revision' '3'");
  expect(output.stdout).toContain("'--idempotency-key'");
  expect(output.stdout).toContain("Status: dure 'runtime' 'get' 'agent-1'");
  expect(output.stdout).not.toContain("Publish:");
  expect(calls.map((request) => request.operation)).toEqual([
    "agent_runtime.projection.inspect", ...(confirmed ? ["agent_runtime.wake"] : []),
  ]);
  expect(nativeCalls()).toEqual([]);
  expect(existsSync(join(root, "server.json"))).toBe(false);
});

it("retains the original wake request after response loss for replay from another CLI process", async () => {
  let wakeCalls = 0;
  const { root, calls, runCommand, nativeCalls } = await fixture((request) => {
    if (request.operation === "agent_runtime.projection.inspect") return { result: dormantProjection() };
    return ++wakeCalls === 1 ? { drop: true } : { result: projection() };
  });
  writeRegistry(root);
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code).toBe(1);
  const report = JSON.parse(output.stderr);
  expect(report).toMatchObject({ ok: false, state: "unknown", publication: "unconfirmed" });
  expect(wakeCalls).toBe(1);
  const retry = await runCommand(report.continuation.retry);
  expect(retry.code, retry.stderr).toBe(0);
  expect(calls[2].body).toEqual(calls[1].body);
  expect(calls[2].requestId).toBe(calls[1].requestId);
  expect(nativeCalls()).toEqual([]);
});

it("executes a confirmed name through native start and publishes its original source without an app", async () => {
  const { root, calls, runCommand, installNative, nativeCalls } = await fixture((request) =>
    request.operation === "agent_runtime.projection.inspect" ? { result: projection() } : undefined);
  writeRegistry(root);
  installNative();
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code, output.stderr).toBe(0);
  const report = JSON.parse(output.stdout);
  expect(report).toMatchObject({ ok: true, nativeExecution: "completed", publication: "published" });
  expect(nativeCalls()).toEqual([sourceLookup, [
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

it("waits for a rehost another executor is applying, then publishes it once", async () => {
  const { root, calls, runCommand, installNative, nativeCalls } = await fixture((request) =>
    request.operation === "agent_runtime.projection.inspect" ? { result: projection() } : undefined);
  writeRegistry(root);
  installNative({ busyFirst: true });
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code, output.stderr).toBe(0);
  const report = JSON.parse(output.stdout);
  expect(report).toMatchObject({ ok: true, nativeExecution: "completed", publication: "published",
    receipt: { replayed: true } });
  const identity = ["--session", "runtime-native-1", "--workspace", "workspace-1",
    "--operation-id", report.continuation.operationId];
  expect(nativeCalls()).toEqual([
    sourceLookup,
    ["managed-rehost-start", ...identity, "--confirm-restart", "--json"],
    ["managed-rehost-resolve", ...identity, "--json"],
    ["managed-rehost-reconcile", ...identity, "--confirm-restart", "--json"],
  ]);
  expect(calls.map((request) => request.operation)).toEqual(["agent_runtime.projection.inspect", operation]);
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
  expect(nativeCalls().map(([subcommand]) => subcommand)).toEqual(["managed-rehost-resolve", "managed-rehost-start"]);
  expect(output.code).toBe(1);
  const report = JSON.parse(output.stderr);
  expect(report).toMatchObject({ ok: false, nativeExecution: "unknown", publication: "not_requested" });
  expect(report.continuation.status).toContain(report.continuation.operationId);
  expect(report.continuation.retry).toContain(report.continuation.operationId);
  expect(calls.map((request) => request.operation)).toEqual(["agent_runtime.projection.inspect"]);
});

it("does not report a named restart as finished while Hmux still applies it", async () => {
  const value = (argv, flag) => argv[argv.indexOf(flag) + 1];
  const run = vi.fn(async (argv) => argv[1] === "managed-rehost-resolve"
    ? { kind: "success", stdout: JSON.stringify({ schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1,
        state: "retry_required", code: "hmux_managed_rehost_retry_required",
        operationId: value(argv, "--operation-id"),
        source: { sessionId: value(argv, "--session"), workspaceId: value(argv, "--workspace") } }) }
    : { kind: "timeout" });
  const requestBackend = vi.fn(async (_profile, request) => {
    if (request.operation === "agent_runtime.projection.inspect") return { result: projection() };
    throw new Error(`Unexpected operation: ${request.operation}`);
  });
  let time = 0;
  const report = await collectManagedRehostNamed({
    opts: { rest: ["rehost"], name: "project/worker", confirmRestart: true },
    registry: { state: "absent", agents: [] }, agentId: "agent-1",
    resolveBackend: async () => ({ profile: { id: "fixture", transport: { kind: "local" } } }),
    requestBackend, command: "hmux", run,
    settle: { now: () => time, sleep: async (ms) => { time += Math.max(1, ms); } },
  });
  expect(report).toMatchObject({ ok: false, state: "running", nativeExecution: "running",
    publication: "not_requested", error: { code: "rehost_still_running" } });
  expect(managedRecoveryExitCode(report, 1)).toBe(MANAGED_REHOST_RUNNING_EXIT_CODE);
  expect(managedRecoveryExitCode({ ...report, ok: true, state: "completed" }, 1)).toBe(0);
  expect(managedRecoveryExitCode({ ...report, state: "unknown" }, 1)).toBe(1);
  expect(run.mock.calls.filter(([argv]) => argv[1] !== "managed-rehost-resolve")).toHaveLength(1);
  expect(requestBackend.mock.calls.map(([, request]) => request.operation)).toEqual([
    "agent_runtime.projection.inspect"]);
});

it("does not report a named restart as finished when its binding publication is lost", async () => {
  let publicationAttempts = 0;
  const { root, calls, runCommand, installNative, nativeCalls } = await fixture((request) => {
    if (request.operation === "agent_runtime.projection.inspect") return { result: projection() };
    if (++publicationAttempts === 1) return { drop: true };
  });
  writeRegistry(root);
  installNative();
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code, output.stdout).toBe(1);
  const report = JSON.parse(output.stderr);
  expect(report).toMatchObject({ ok: false, state: "completed", nativeExecution: "completed",
    publication: "unconfirmed" });
  expect(report.error).toEqual(report.publicationError);
  expect(report.receipt.operationId).toBe(report.continuation.operationId);
  expect(report.continuation.finish).toContain(report.continuation.operationId);
  writeRegistry(root, [{ ...projectedAgent, id: "different-agent" }]);
  const published = await runCommand(report.continuation.publish);
  expect(published.code, published.stderr).toBe(0);
  expect(calls[2].body).toEqual(calls[1].body);
  expect(nativeCalls().map(([subcommand]) => subcommand)).toEqual(["managed-rehost-resolve", "managed-rehost-start"]);
});

it("finishes a lost publication with one command that never starts another operation", async () => {
  let publicationAttempts = 0;
  const { root, calls, runCommand, installNative, nativeCalls } = await fixture((request) => {
    if (request.operation === "agent_runtime.projection.inspect") return { result: projection() };
    if (++publicationAttempts === 1) return { drop: true };
  });
  writeRegistry(root);
  installNative();
  const lost = JSON.parse((await runCommand([...previewArgs, "--confirm-restart"])).stderr);
  const { operationId, finish } = lost.continuation;
  expect(finish).toEqual(["hmux", "rehost", "finish", "agent-1", "--from-session", "runtime-native-1",
    "--workspace", "workspace-1", "--operation-id", operationId, "--confirm-restart", "--backend", "fixture", "--json"]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const finished = await runCommand(finish);
    expect(finished.code, finished.stderr).toBe(0);
    expect(JSON.parse(finished.stdout)).toMatchObject({ ok: true, state: "completed", agentId: "agent-1", operationId,
      nativeExecution: "completed", publication: "published", receipt: { operationId, replayed: true } });
  }
  // One admission; each finish only replayed the completed journal and published the same tuple.
  expect(nativeCalls().map(([subcommand]) => subcommand)).toEqual(["managed-rehost-resolve", "managed-rehost-start",
    "managed-rehost-reconcile", "managed-rehost-reconcile"]);
  expect(calls.slice(1).map((request) => request.body)).toEqual(Array(3).fill({ schemaVersion: 1, agentId: "agent-1",
    operationId, sourceSessionId: "runtime-native-1", sourceWorkspaceId: "workspace-1" }));
});

it("continues a natively completed restart Hmux holds instead of starting another one", async () => {
  const { root, calls, runCommand, installNative, holdNative, nativeCalls } = await fixture((request) =>
    request.operation === "agent_runtime.projection.inspect" ? { result: projection() } : undefined);
  writeRegistry(root);
  installNative();
  holdNative("operation-held", "completed");
  const preview = await runCommand(previewArgs.filter((arg) => arg !== "--json"));
  expect(preview.code, preview.stderr).toBe(0);
  expect(preview.stdout).toContain("Hmux already restarted this Agent (operation operation-held), but its binding is not published yet.");
  expect(preview.stdout).toContain("Finish: dure 'hmux' 'rehost' 'finish' 'agent-1' '--from-session' 'runtime-native-1'");
  expect(preview.stdout).not.toContain("Start:");
  const output = await runCommand([...previewArgs, "--confirm-restart"]);
  expect(output.code, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toMatchObject({ ok: true, state: "completed", publication: "published",
    continuation: { operationId: "operation-held", retained: { operationId: "operation-held", nativeState: "completed" } },
    receipt: { operationId: "operation-held", replayed: true } });
  expect(nativeCalls().filter(([subcommand]) => subcommand === "managed-rehost-start")).toEqual([]);
  expect(calls.filter((request) => request.operation === operation).map((request) => request.body.operationId))
    .toEqual(["operation-held"]);
});

it("previews a restart Hmux is still applying with its exact Finish command and reads only the journal", async () => {
  const { root, calls, runCommand, installNative, holdNative, nativeCalls } = await fixture((request) =>
    request.operation === "agent_runtime.projection.inspect" ? { result: projection() } : undefined);
  writeRegistry(root);
  installNative();
  holdNative("operation-applying", "applying");
  const output = await runCommand(previewArgs);
  expect(output.code, output.stderr).toBe(0);
  const { continuation } = JSON.parse(output.stdout);
  expect(continuation).toMatchObject({ operationId: "operation-applying",
    retained: { operationId: "operation-applying", nativeState: "running" } });
  expect(continuation.start).toEqual(continuation.retry);
  expect(nativeCalls()).toEqual([sourceLookup, ["managed-rehost-resolve", "--session", "runtime-native-1",
    "--workspace", "workspace-1", "--operation-id", "operation-applying", "--json"]]);
  expect(calls.map((request) => request.operation)).toEqual(["agent_runtime.projection.inspect"]);
});

it("does not report a finish as done while Hmux still applies the operation", async () => {
  const value = (argv, flag) => argv[argv.indexOf(flag) + 1];
  let applying = true;
  const run = vi.fn(async (argv) => {
    const source = { sessionId: value(argv, "--session"), workspaceId: value(argv, "--workspace") };
    if (argv[1] === "managed-rehost-resolve") {
      return { kind: "success", stdout: JSON.stringify(applying
        ? { schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, state: "retry_required",
          code: "hmux_managed_rehost_retry_required", operationId: value(argv, "--operation-id"), source }
        : { schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, state: "resolved",
          operationIds: [value(argv, "--operation-id")], sourceGeneration: source,
          currentGeneration: { sessionId: "successor-1", workspaceId: source.workspaceId } }) };
    }
    return applying
      ? { kind: "nonzero", stdout: JSON.stringify({ schema: "hmux-managed-rehost-v1", schemaVersion: 1, state: "refused",
        error: { code: "hmux_recovery_busy", message: "hmux_recovery_busy: recovery operation is already running" } }) }
      : { kind: "success", stdout: JSON.stringify({ schema: "hmux-managed-rehost-v1", schemaVersion: 1,
        operationId: value(argv, "--operation-id"), replayed: true, sourceStopReceipt: source,
        replacementReceipt: { sessionId: "successor-1", workspaceId: source.workspaceId } }) };
  });
  const requestBackend = vi.fn(async () => ({ result: { schemaVersion: 1,
    receipt: { schemaVersion: 1, agentId: "agent-1", operationId: "operation-1", selectionRevision: 2 } } }));
  let time = 0;
  const finish = () => collectManagedRehostFinish({
    opts: { rest: ["rehost", "finish", "agent-1"], fromSession: "source-1", workspace: "workspace-1",
      operationId: "operation-1", confirmRestart: true },
    resolveBackend: async () => ({ profile: { id: "fixture", transport: { kind: "local" } } }),
    requestBackend, command: "hmux", run,
    settle: { now: () => time, sleep: async (ms) => { time += Math.max(1, ms); } },
  });
  const running = await finish();
  expect(running).toMatchObject({ ok: false, state: "running", nativeExecution: "running",
    publication: "not_requested", error: { code: "rehost_still_running" } });
  expect(managedRecoveryExitCode(running, 1)).toBe(MANAGED_REHOST_RUNNING_EXIT_CODE);
  expect(run.mock.calls.map(([argv]) => argv[1]).filter((subcommand) => subcommand !== "managed-rehost-resolve"))
    .toEqual(["managed-rehost-reconcile"]);
  expect(requestBackend).not.toHaveBeenCalled();
  applying = false;
  const finished = await finish();
  expect(finished).toMatchObject({ ok: true, state: "completed", publication: "published" });
  expect(managedRecoveryExitCode(finished, 1)).toBe(0);
  expect(requestBackend.mock.calls.map(([, request]) => request.body)).toEqual([{ schemaVersion: 1,
    agentId: "agent-1", operationId: "operation-1", sourceSessionId: "source-1", sourceWorkspaceId: "workspace-1" }]);
});

it.each([
  [[]],
  [["--confirm-restart", "--fresh"]],
  [["--confirm-restart", "--name", "worker"]],
])("refuses a finish request outside its exact identity before any native or backend call: %j", async (extra) => {
  const { calls, runCommand, installNative, nativeCalls } = await fixture();
  installNative();
  const output = await runCommand(["hmux", "rehost", "finish", "agent-1", "--from-session", "source-1",
    "--workspace", "workspace-1", "--operation-id", "operation-1", "--backend", "fixture", "--json", ...extra]);
  expect(output.code).toBe(1);
  expect(JSON.parse(output.stderr)).toMatchObject({ ok: false, error: { code: "rehost_finish_request_invalid" } });
  expect(nativeCalls()).toEqual([]);
  expect(calls).toEqual([]);
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

it("names a missing Agent's recovery path and lists every same-named Agent with an exact selector", async () => {
  const { root, calls, runCommand } = await fixture();
  writeRegistry(root, []);
  const missing = await runCommand(previewArgs.filter((arg) => arg !== "--json"));
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("rehost_name_not_found: No Agent named project/worker");
  expect(missing.stderr).toContain("dure runs resume <agent-id>");

  writeRegistry(root, [projectedAgent, { ...projectedAgent, id: "agent-2", sessionId: "session-2" },
    { ...projectedAgent, id: "agent-3", project: "elsewhere", sessionId: "session-3" }]);
  const ambiguous = await runCommand(["hmux", "rehost", "--name", "worker", "--backend", "fixture", "--json"]);
  expect(ambiguous.code).toBe(1);
  expect(JSON.parse(ambiguous.stderr)).toMatchObject({ ok: false, error: { code: "rehost_name_not_unique", candidates: [
    { agentId: "agent-1", project: "project", retry: ["runs", "resume", "agent-1"] },
    { agentId: "agent-2", project: "project", retry: ["runs", "resume", "agent-2"] },
    { agentId: "agent-3", project: "elsewhere", retry: ["hmux", "rehost", "--name", "elsewhere/Renamed worker"] },
  ] } });
  const text = await runCommand(["hmux", "rehost", "--name", "worker", "--backend", "fixture"]);
  expect(text.stderr).toContain("3 Agents match worker");
  expect(text.stderr).toContain("dure 'runs' 'resume' 'agent-2'");
  expect(calls).toEqual([]);
});

const stoppedProjection = () => ({
  schemaVersion: 1, state: "closed", agentId: "agent-1", operationId: "close-operation", stage: "stopped",
  projectionContext: agentRuntimeProjectionContext(),
  source: { selectionRevision: 4, interactionProfile: "native_cli",
    launchSelection: { model: null, effort: null, permissionMode: "default" } },
});

it.each([false, true])("restarts a stopped Agent through the backend transition without native rehost (confirmed: %s)", async (confirmed) => {
  const { root, calls, runCommand, nativeCalls } = await fixture((request) => ({
    result: request.operation === "agent_runtime.projection.inspect" ? stoppedProjection()
      : { schemaVersion: 1, receipt: { ...projection().receipt, selectionRevision: 5 } },
  }));
  writeRegistry(root);
  const output = await runCommand([...previewArgs.filter((arg) => arg !== "--json"),
    ...(confirmed ? ["--confirm-restart"] : [])]);
  expect(output.code, output.stderr).toBe(0);
  expect(output.stdout).toContain(confirmed ? "agent-1: restart completed" : "Preview: agent-1 (stopped runtime)");
  expect(output.stdout).toContain("Restart: dure 'runtime' 'switch' 'agent-1' 'terminal' '--expected-revision' '4'");
  expect(calls.map((request) => request.operation)).toEqual([
    "agent_runtime.projection.inspect", ...(confirmed ? ["agent_runtime.transition"] : []),
  ]);
  if (confirmed) {
    expect(calls[1].body).toEqual({ schemaVersion: 1, agentId: "agent-1",
      targetInteractionProfile: "native_cli", expectedSourceRevision: 4 });
  }
  expect(nativeCalls()).toEqual([]);
  expect(existsSync(join(root, "server.json"))).toBe(false);
});
