import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectAgentRuntimeCommand,
  formatAgentRuntimeCommand,
} from "../cli/lib/agent-runtime-command.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { createDureAgentRuntimeClient } from "../src/lib/ipc/dureAgentRuntime.ts";
import { installRemoteBackendFixture } from "./lib/dure-cli-ssh-fixture.mjs";
import {
  agentRuntimeBackendEnvelope,
  agentRuntimeProjectionContext,
  nativeRuntimeReceipt,
} from "../src/test/dureAgentRuntimeFixtures.ts";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const receipt = {
  schemaVersion: 1,
  receipt: nativeRuntimeReceipt({ kind: "provider_default" }, 3, "launch-3"),
};
const projection = {
  ...receipt, state: "stable", projectionContext: agentRuntimeProjectionContext(),
};

describe("headless runtime command", () => {
  it("prints journal-backed stop and wake outcomes without treating a request as cleanup", () => {
    const report = {
      ok: true, action: "idle", requestId: "outcome-observation",
      result: {
        schemaVersion: 1, configuration: "disabled", afterMs: null,
        observedAtMs: null, partial: false, reasonCode: null, agents: [],
        reclamation: {
          schemaVersion: 1, state: "available", observedAtMs: 500,
          scope: "latest_runtime_transition_admissions", scanned: 1, limit: 64,
          partial: false, reasonCode: null,
          entries: [{
            agentId: "agent-1", providerId: "codex", operationId: "sleep-1",
            journalRevision: 2, stage: "source_stopped", stopState: "completed",
            wakeState: "not_requested", sourceSessionId: "session-1",
            requestedAtMs: 100, updatedAtMs: 200, reasonCode: null,
          }],
        },
      },
    };
    const output = formatAgentRuntimeCommand(report);
    expect(output).toContain("sleep-1: source stop completed; wake not_requested");
    expect(output).toContain("Memory bytes and auxiliary-process release: unmeasured");
    expect(output).not.toContain("Wake: dure");
  });

  it.each(["local", "ssh"])("configures one durable backend idle policy over %s", async (kind) => {
    for (const enabled of [true, false]) {
      const policy = enabled ? { mode: "enabled", afterMs: 1_800_000 } : { mode: "disabled" };
      const result = {
        schemaVersion: 1, configuration: enabled ? "enabled" : "disabled",
        afterMs: enabled ? 1_800_000 : null, policyRevision: 1,
        observedAtMs: null, partial: false, reasonCode: null, agents: [],
      };
      const calls = [];
      const report = await collectAgentRuntimeCommand({
        args: enabled ? ["idle", "set", "1800000"] : ["idle", "disable"],
        expectedRevision: 0, requestId: "configure-policy",
        resolveBackend: async () => ({ profile: { id: "selected", transport: { kind } } }),
        requestBackend: async (_profile, request) => { calls.push(request); return { result }; },
      });
      expect(report).toMatchObject({ ok: true, result });
      expect(calls).toEqual([{
        requestId: "configure-policy", operation: "agent_runtime.idle.configure",
        requiredCapabilities: ["agent_runtime.idle.configure"],
        body: { schemaVersion: 1, expectedRevision: 0, policy },
      }]);
      expect(formatAgentRuntimeCommand(report)).toContain("Policy revision: 1");
    }
  });

  it.each([
    { args: ["idle", "disable"] },
    { args: ["idle", "set", "1000"] },
    { args: ["idle", "set", "01000"], expectedRevision: 0 },
    { args: ["idle", "set", "999"], expectedRevision: 0 },
    { args: ["idle", "set", "2592000001"], expectedRevision: 0 },
    { args: ["idle", "disable", "1000"], expectedRevision: 0 },
    { args: ["idle", "disable"], expectedRevision: -1 },
    { args: ["idle", "disable"], expectedRevision: Number.MAX_SAFE_INTEGER },
    { args: ["idle"], expectedRevision: 0 },
    { args: ["idle", "disable"], expectedRevision: 0, operationId: "sleep-1" },
  ])("rejects ambiguous or unfenced idle policy intent before transport: %j", async (input) => {
    const report = await collectAgentRuntimeCommand({ ...input, resolveBackend: async () => {
      throw new Error("invalid intent must not resolve a backend");
    } });
    expect(report).toMatchObject({ ok: false, error: { code: "runtime_command_invalid" } });
  });

  it.each([{ policyRevision: undefined }, { policyRevision: 2 }, { afterMs: 1000 }])(
    "rejects a configure response that does not receipt the exact policy write: %j", async (changes) => {
      const report = await collectAgentRuntimeCommand({
        args: ["idle", "disable"], expectedRevision: 0,
        resolveBackend: async () => ({ profile: { id: "selected" } }),
        requestBackend: async () => ({ result: {
          schemaVersion: 1, configuration: "disabled", afterMs: null, policyRevision: 1,
          observedAtMs: null, partial: false, reasonCode: null, agents: [], ...changes,
        } }),
      });
      expect(report).toMatchObject({ ok: false, error: { code: "runtime_response_invalid" } });
    },
  );

  it.each([
    { configuration: "enabled", afterMs: null },
    { configuration: "disabled", afterMs: 1_000 },
    { afterMs: 999 },
    { afterMs: 2_592_000_001 },
    { observedAtMs: 8_640_000_000_000_001 },
    { observedAtMs: undefined },
    { partial: undefined },
    { agents: Array.from({ length: 65 }, () => ({
      agentId: "agent-1", state: "observing", observedIdleMs: 0, reasonCode: null,
    })) },
    { agents: [{ agentId: "agent-1", state: "observing", observedIdleMs: -1, reasonCode: null }] },
  ])("rejects unusable idle observations without attempting cleanup: %j", async (changes) => {
    const calls = [];
    const report = await collectAgentRuntimeCommand({
      args: ["idle"],
      resolveBackend: async () => ({ profile: { id: "selected" } }),
      requestBackend: async (_profile, request) => {
        calls.push(request.operation);
        return { result: {
          schemaVersion: 1, configuration: "enabled", afterMs: 1_800_000,
          observedAtMs: null, partial: false, reasonCode: null, agents: [], ...changes,
        } };
      },
    });
    expect(report).toMatchObject({ ok: false, error: { code: "runtime_response_invalid" } });
    expect(calls).toEqual(["agent_runtime.idle.inspect"]);
    expect(formatAgentRuntimeCommand(report)).toContain("Inspect: dure runtime idle --backend selected");
  });

  it.each(["local", "ssh"])("observes automatic idle policy over %s without starting cleanup", async (kind) => {
    const result = {
      schemaVersion: 1, configuration: "enabled", afterMs: 1_800_000,
      observedAtMs: 42, partial: true, reasonCode: null,
      agents: [{ agentId: "agent-1", state: "protected", observedIdleMs: null,
        reasonCode: "agent_runtime_semantic_idle_unavailable" }],
    };
    const calls = [];
    const report = await collectAgentRuntimeCommand({
      args: ["idle"], requestId: "idle-observation",
      resolveBackend: async () => ({ profile: { id: "selected", transport: { kind } } }),
      requestBackend: async (_profile, request) => { calls.push(request); return { result }; },
    });
    expect(report).toMatchObject({ ok: true, result });
    expect(calls).toEqual([{
      requestId: "idle-observation", operation: "agent_runtime.idle.inspect",
      requiredCapabilities: ["agent_runtime.idle.inspect"], body: { schemaVersion: 1 },
    }]);
    expect(formatAgentRuntimeCommand(report)).toContain("partial page");
    expect(formatAgentRuntimeCommand(report)).toContain("agent_runtime_semantic_idle_unavailable");
    expect(formatAgentRuntimeCommand(report)).not.toContain("undefined");
  });

  it.each([
    { deferredTarget: { state: "unknown" } },
    { deferredTarget: { state: "waiting" }, journalRevision: 0 },
    { deferredTarget: { state: "waiting" }, operationId: "bad operation" },
    { deferredTarget: { state: "requested", operationId: "wake-1" } },
    { deferredTarget: { state: "waiting" }, stage: "committed" },
  ])("does not print an actionable wake from malformed deferred evidence: %j", async (changes) => {
    const result = {
      schemaVersion: 1, state: "transitioning", agentId: "agent-1",
      projectionContext: agentRuntimeProjectionContext(), operationId: "hibernate-1",
      journalRevision: 2, stage: "source_stopped", targetInteractionProfile: "native_cli",
      targetExecutionProfile: { kind: "provider_default" }, ...changes,
    };
    const report = await collectAgentRuntimeCommand({
      args: ["get", "agent-1"], resolveBackend: async () => ({ profile: { id: "selected" } }),
      requestBackend: async () => ({ result }),
    });
    expect(report).toMatchObject({ ok: true, result });
    expect(formatAgentRuntimeCommand(report)).not.toContain("Wake:");
    expect(formatAgentRuntimeCommand(report)).not.toContain("dormant");
  });

  it.each(["local", "ssh"])("uses journal-fenced hibernate and wake over %s without a second cleanup path", async (kind) => {
    const dormant = {
      schemaVersion: 1, state: "transitioning", agentId: "agent-1",
      projectionContext: agentRuntimeProjectionContext(),
      operationId: "hibernate-1", journalRevision: 2, stage: "source_stopped",
      targetInteractionProfile: "native_cli",
      targetExecutionProfile: { kind: "provider_default" },
      deferredTarget: { state: "waiting" },
    };
    for (const action of ["hibernate", "wake"]) {
      const calls = [];
      const result = action === "hibernate" ? dormant : projection;
      const report = await collectAgentRuntimeCommand({
        args: [action, "agent-1"], expectedRevision: 2,
        operationId: action === "wake" ? "hibernate-1" : undefined,
        requestId: `one-${action}`,
        resolveBackend: async () => ({ profile: { id: "selected", transport: { kind } } }),
        requestBackend: async (_profile, request) => { calls.push(request); return { result }; },
      });
      expect(report).toMatchObject({ ok: true, result });
      expect(calls).toEqual([{
        requestId: `one-${action}`, operation: `agent_runtime.${action}`,
        requiredCapabilities: [`agent_runtime.${action}`],
        body: action === "hibernate"
          ? { schemaVersion: 1, agentId: "agent-1", expectedSourceRevision: 2 }
          : { schemaVersion: 1, agentId: "agent-1", operationId: "hibernate-1", expectedJournalRevision: 2 },
      }]);
      if (action === "hibernate") {
        expect(formatAgentRuntimeCommand(report)).toContain("dormant");
        expect(formatAgentRuntimeCommand(report)).toContain("--operation-id hibernate-1 --expected-revision 2");
        expect(formatAgentRuntimeCommand(report)).toContain("--backend selected");
      }
    }
  });

  it.each([
    { args: ["hibernate", "agent-1"] },
    { args: ["hibernate", "agent-1"], expectedRevision: 0 },
    { args: ["wake", "agent-1"], expectedRevision: 2 },
    { args: ["wake", "agent-1"], expectedRevision: 1.5, operationId: "hibernate-1" },
    { args: ["hibernate", "bad agent"], expectedRevision: 2 },
    { args: ["wake", "agent-1"], expectedRevision: 2, operationId: "bad operation" },
    { args: ["hibernate", "agent-1"], expectedRevision: 2, conversationId: "conversation-1" },
    { args: ["wake", "agent-1"], expectedRevision: 2, operationId: "sleep-1", conversationId: "" },
    { args: ["wake", "agent-1"], expectedRevision: 2, operationId: "sleep-1", conversationId: " conversation-1" },
  ])("rejects unfenced lifecycle input before resolving a backend: %j", async (input) => {
    let resolutions = 0;
    const report = await collectAgentRuntimeCommand({
      ...input, resolveBackend: async () => { resolutions++; return {}; },
    });
    expect(report).toMatchObject({ ok: false, error: { code: "runtime_command_invalid" } });
    expect(resolutions).toBe(0);
  });

  it.each(["local", "ssh"])("accepts additive runtime metadata over %s without sending it back", async (kind) => {
    const result = { ...projection, futureObservation: "not an execution input", receipt: { ...projection.receipt, futureObservation: true } };
    const calls = [];
    const report = await collectAgentRuntimeCommand({
      args: ["get", "agent-1"],
      resolveBackend: async () => ({ profile: { id: "selected", transport: { kind } } }),
      requestBackend: async (_profile, request) => {
        calls.push(request);
        return { result };
      },
    });
    expect(report).toMatchObject({ ok: true, result });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("futureObservation");
  });

  it.each(["local", "ssh"])("reads canonical Agent workspace identity over %s in one request", async (kind) => {
    const context = agentRuntimeProjectionContext();
    const result = { ...receipt, state: "stable", projectionContext: context };
    const calls = [];
    const report = await collectAgentRuntimeCommand({
      args: ["get", "agent-1"],
      resolveBackend: async () => ({ profile: { id: "selected", transport: { kind } } }),
      requestBackend: async (_profile, request) => {
        calls.push(request);
        return { result };
      },
    });
    expect(report).toMatchObject({ ok: true, result: { projectionContext: context } });
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe("agent_runtime.projection.inspect");
  });

  it("accepts the same structured transition receipt as the desktop client", async () => {
    const result = agentRuntimeBackendEnvelope().result;
    const report = await collectAgentRuntimeCommand({
      args: ["switch", "agent-1", "chat"],
      resolveBackend: async () => ({ profile: { id: "selected" } }),
      requestBackend: async () => ({ result }),
    });
    expect(report).toMatchObject({ ok: true, result });
    expect(formatAgentRuntimeCommand(report)).toContain(
      "stable (structured_protocol)",
    );
  });

  it.each([
    { schemaVersion: 1, state: "unmanaged", agentId: "another-agent" },
    {
      schemaVersion: 1,
      state: "stable",
      receipt: agentRuntimeBackendEnvelope({ agentId: "another-agent" }).result.receipt,
    },
    { schemaVersion: 1, state: "stable" },
    { schemaVersion: 2, state: "unmanaged", agentId: "agent-1" },
    { ...receipt, state: "stable" },
    { ...projection, projectionContext: agentRuntimeProjectionContext("another-agent") },
    { ...projection, projectionContext: agentRuntimeProjectionContext("agent-1", "codex") },
    { ...projection, projectionContext: {
      ...projection.projectionContext,
      workspace: { ...projection.projectionContext.workspace, workspaceId: "another-workspace" },
    } },
    { ...projection, projectionContext: {
      ...projection.projectionContext,
      project: { ...projection.projectionContext.project, projectId: "another-project" },
    } },
  ])("rejects a mismatched or malformed inspection envelope: %j", async (result) => {
    const report = await collectAgentRuntimeCommand({
      args: ["get", "agent-1"],
      resolveBackend: async () => ({ profile: { id: "selected" } }),
      requestBackend: async () => ({ result }),
    });
    expect(report).toMatchObject({
      ok: false,
      error: { code: "runtime_response_invalid" },
    });
    await expect(createDureAgentRuntimeClient({
      invokeCommand: async () => ({ ...agentRuntimeBackendEnvelope(), result }),
    }).inspect("agent-1")).rejects.toMatchObject({
      code: "agent_runtime_transition_response_invalid",
    });
  });

  it.each(["local", "ssh"])(
    "sends one semantic target through %s without frontend repair planning",
    async (kind) => {
      const calls = [];
      const report = await collectAgentRuntimeCommand({
        args: ["switch", "agent-1", "terminal"],
        requestId: "same-target-request",
        resolveBackend: async () => ({
          profile: { id: "selected", transport: { kind } },
        }),
        requestBackend: async (profile, request) => {
          calls.push({ profile, request });
          return { backend: { id: "selected" }, result: receipt };
        },
      });
      expect(report).toMatchObject({
        ok: true,
        result: receipt,
        requestId: "same-target-request",
      });
      expect(calls).toEqual([
        {
          profile: { id: "selected", transport: { kind }, deadlineMs: 45_000 },
          request: {
            requestId: "same-target-request",
            operation: "agent_runtime.transition",
            requiredCapabilities: ["agent_runtime.transition"],
            body: {
              schemaVersion: 1,
              agentId: "agent-1",
              targetInteractionProfile: "native_cli",
            },
          },
        },
      ]);
    },
  );

  it("projects a parked operation as state rather than successful replacement", async () => {
    const result = {
      schemaVersion: 1,
      state: "transitioning",
      projectionContext: agentRuntimeProjectionContext(),
      agentId: "agent-1",
      stage: "repair_required",
      operationId: "parked",
      journalRevision: 2,
      targetInteractionProfile: "native_cli",
      targetExecutionProfile: { kind: "provider_default" },
      targetFailure: { kind: "launch_failed", providerCode: "provider_exited" },
    };
    const report = await collectAgentRuntimeCommand({
      args: ["get", "agent-1"],
      resolveBackend: async () => ({ profile: { id: "selected" } }),
      requestBackend: async (_profile, request) => {
        expect(request.operation).toBe("agent_runtime.projection.inspect");
        return { result };
      },
    });
    expect(report).toMatchObject({ ok: true, result });
    expect(formatAgentRuntimeCommand(report)).toContain("transitioning");
    expect(formatAgentRuntimeCommand(report)).toContain(
      "Stage: repair_required",
    );
    expect(formatAgentRuntimeCommand(report)).toContain("Operation: parked");
  });

  it("does not turn response loss into another mutation", async () => {
    let calls = 0;
    const report = await collectAgentRuntimeCommand({
      args: ["switch", "agent-1", "chat"],
      requestId: "lost-response",
      resolveBackend: async () => ({ profile: { id: "selected" } }),
      requestBackend: async () => {
        calls++;
        throw new BackendTransportError("backend_transport_remote_error", {
          details: { code: "agent_runtime_repair_in_progress" },
        });
      },
    });
    expect(calls).toBe(1);
    expect(report).toMatchObject({ ok: false, requestId: "lost-response" });
    expect(formatAgentRuntimeCommand(report)).toContain(
      "agent_runtime_repair_in_progress",
    );
    expect(formatAgentRuntimeCommand(report)).toContain(
      "dure runtime get agent-1",
    );
  });

  it("rejects an unknown target before resolving or starting a backend", async () => {
    const report = await collectAgentRuntimeCommand({
      args: ["switch", "agent-1", "automatic"],
      resolveBackend: () => {
        throw new Error("unexpected backend resolution");
      },
      requestBackend: () => {
        throw new Error("unexpected request");
      },
    });
    expect(report).toMatchObject({
      ok: false,
      error: { code: "runtime_command_invalid" },
    });
  });

  it.each(["get", "switch", "hibernate", "wake", "idle", "idle set", "idle disable"])("runs runtime %s through SSH without an app registry", (action) => {
    const root = mkdtempSync(join(tmpdir(), "dure-runtime-command."));
    roots.push(root);
    const idle = action.startsWith("idle");
    const configure = idle && action !== "idle";
    const operation = idle ? `agent_runtime.idle.${configure ? "configure" : "inspect"}` : action === "get" ? "agent_runtime.projection.inspect" :
      action === "switch" ? "agent_runtime.transition" : `agent_runtime.${action}`;
    const result = idle ? {
      schemaVersion: 1, configuration: action === "idle set" ? "enabled" : "disabled",
      afterMs: action === "idle set" ? 1_800_000 : null,
      ...(configure ? { policyRevision: 1 } : {}),
      observedAtMs: null, partial: false, reasonCode: null, agents: [],
    } : action === "switch" ? receipt : projection;
    const capabilities = [operation];
    const fixture = installRemoteBackendFixture(root, [], { capabilities });
    writeFileSync(
      join(fixture.bin, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(process.env.DURE_SESSION_REQUEST_LOG, JSON.stringify(request) + "\\n");
process.stdout.write(JSON.stringify({
  schemaVersion: 1, apiVersion: "dure.backend-transport/v1", kind: "dure.backend.response",
  requestId: request.requestId,
  backend: { id: "remote-backend", generation: "remote-generation-1", protocol: { major: 1, minor: 0 }, capabilities: ${JSON.stringify(capabilities)}, observedAtMs: Date.now() },
  result: ${JSON.stringify(result)},
}));
`,
    );
    const run = spawnSync(
      process.execPath,
      [
        cliPath,
        "runtime",
        ...action.split(" "),
        ...(idle ? [] : ["agent-1"]),
        ...(action === "idle set" ? ["1800000"] : []),
        ...(configure ? ["--expected-revision", "0"] : []),
        ...(action === "switch" ? ["terminal"] : []),
        ...(action === "hibernate" || action === "wake" ? ["--expected-revision", "2"] : []),
        ...(action === "wake" ? ["--operation-id", "sleep-1", "--conversation-id", "conversation-1"] : []),
        "--backend",
        "remote-build",
        "--idempotency-key",
        "cli-target-1",
        "--json",
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          DURE_HOME: root,
          DURE_APP_CHANNEL: "stable",
          DURE_SESSION_REQUEST_LOG: fixture.requestLog,
          DURE_BACKEND_SSH_REFERENCE_PROFILE: "remote-build",
          DURE_BACKEND_KNOWN_HOSTS_FILE: fixture.knownHostsFile,
          PATH: `${fixture.bin}:${process.env.PATH}`,
        },
      },
    );
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, result });
    const request = JSON.parse(readFileSync(fixture.requestLog, "utf8"));
    expect(request).toMatchObject({
      requestId: "cli-target-1",
      operation,
    });
    if (action === "hibernate") expect(request.body).toEqual({ schemaVersion: 1, agentId: "agent-1", expectedSourceRevision: 2 });
    if (action === "idle") expect(request.body).toEqual({ schemaVersion: 1 });
    if (configure) expect(request.body).toEqual({
      schemaVersion: 1, expectedRevision: 0,
      policy: action === "idle set" ? { mode: "enabled", afterMs: 1_800_000 } : { mode: "disabled" },
    });
    if (action === "wake") expect(request.body).toEqual({ schemaVersion: 1, agentId: "agent-1", operationId: "sleep-1", expectedJournalRevision: 2, expectedProviderConversationRef: "conversation-1" });
    expect(existsSync(join(root, "agents.json"))).toBe(false);
  });

  it("advertises runtime commands without connecting to a backend", () => {
    const run = spawnSync(process.execPath, [cliPath, "runtime", "--help"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      "dure runtime switch <agent-id> chat|terminal",
    );
  });
});
