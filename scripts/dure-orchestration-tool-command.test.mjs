import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCursor } from "../cli/lib/orchestration-client.mjs";
import { runOrchestrationInvokeFromCli } from "../cli/lib/orchestration-command.mjs";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";
import {
  resolveOrchestrationToolReceipt,
  runOrchestrationToolFromCli,
} from "../cli/lib/orchestration-tool-command.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-orch-tool-"));
  roots.push(root);
  return root;
}

function installReceipt(directory, provider) {
  const installRoot = path.join(directory, `.${provider}`, "dure", "orchestration");
  fs.mkdirSync(installRoot, { recursive: true });
  const receiptPath = path.join(installRoot, "install-receipt.json");
  fs.writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 1, provider, version: "fixture-v1", digest: "a".repeat(64),
    channel: "test", capabilities: ["event_cursor_v1"],
  }));
  return receiptPath;
}

function sessionFixture() {
  const root = fixtureRoot();
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const checkpointPath = path.join(root, "cursors", "endpoint-worker.json");
  const environment = {
    CLAUDECODE: "1",
    DURE_HOME: path.join(root, "dure-home"),
    DURE_BACKEND_PROFILE: "local",
    DURE_ORCHESTRATION_CHECKPOINT: checkpointPath,
    HMUX_SESSION_ID: "worker-session", HMUX_WORKSPACE_ID: "runtime-workspace",
    HMUX_RUNNER_PRINCIPAL: "runner-principal", HMUX_RUNNER_INSTANCE: "runner-instance",
    HMUX_CHANNEL_EPOCH: "2", HMUX_HOST_INSTANCE_ID: "host-instance",
    HMUX_TERMINAL_EPOCH: "terminal-epoch",
  };
  const context = {
    schemaVersion: 1,
    target: {
      authority: { workspaceId: "runtime-workspace" },
      runId: "run-1", taskId: "task-1", dispatchId: "dispatch-1", generation: 1,
    },
    participant: "participant-worker",
    deliveryCapability: "capability-delivery",
    acknowledgementCapability: "capability-acknowledgement",
    endpointFence: {
      endpointRef: "endpoint-worker", sessionIdentity: "session-identity", generation: 1,
      deliveryCapability: "capability-delivery", acknowledgementCapability: "capability-acknowledgement",
    },
  };
  return { home, workspace, checkpointPath, environment, context };
}

describe("dure orchestration tool", () => {
  it("acknowledges Events and advances the cursor checkpoint like the MCP tool", async () => {
    const session = sessionFixture();
    const receiptPath = installReceipt(session.home, "claude");
    const request = vi.fn(async (_endpoint, operation) => {
      if (operation.method === "dispatch.context.get") {
        expect(operation.body.session).toMatchObject({ sessionId: "worker-session", providerId: "claude" });
        return { receipt: session.context };
      }
      expect(operation.method).toBe("events.read");
      expect(operation.body.acknowledgement).toEqual({
        through: 7, idempotencyKey: "ack-7", acknowledgementCapability: "capability-acknowledgement",
      });
      return {
        apiVersion: "dure.orchestration/v1", method: "events.read",
        receipt: {
          events: [], deliveries: [], nextCursor: 7,
          acknowledgement: { through: 7, delivery: { eventCursor: 7, state: "acknowledged", receiptId: "delivery-7" } },
        },
      };
    });
    const handle = vi.fn((message, environment, dependencies) =>
      handleMcpRequest(message, environment, { ...dependencies, request }));
    const output = [];

    const { value } = await runOrchestrationToolFromCli({
      arguments_: ["orchestration_events_read", JSON.stringify({ acknowledgement: { through: 7, idempotencyKey: "ack-7" } })],
      environment: session.environment, homeDirectory: session.home, workspaceRoot: session.workspace,
      json: true, output: (source) => output.push(source), handle,
    });

    expect(handle).toHaveBeenLastCalledWith(expect.anything(), session.environment, { receiptPath });
    expect(value.receipt.nextCursor).toBe(7);
    expect(JSON.parse(output.join(""))).toEqual(value);
    expect(loadCursor(session.checkpointPath)).toBe(7);
    expect(request.mock.calls.map(([, operation]) => operation.method)).toEqual(["dispatch.context.get", "events.read"]);
  });

  it("passes the MCP tool's arguments unchanged and prints its notices separately", async () => {
    const session = sessionFixture();
    installReceipt(session.home, "claude");
    const body = { schemaVersion: 1, authority: { workspaceId: "w" }, interactionId: "message-1",
      participant: "author", readCapability: "capability-interaction" };
    const handle = vi.fn(async (message) => {
      if (message.method === "tools/list") return handleMcpRequest(message);
      expect(message.params).toEqual({ name: "orchestration_interaction_get", arguments: { body } });
      return { content: [{ type: "text", text: JSON.stringify({ receipt: { id: "message-1" } }) },
        { type: "text", text: "identity refreshed" }] };
    });
    const output = [];
    const notices = [];

    await runOrchestrationToolFromCli({
      arguments_: ["orchestration_interaction_get", JSON.stringify({ body })],
      environment: session.environment, homeDirectory: session.home, workspaceRoot: session.workspace,
      output: (source) => output.push(source), notice: (source) => notices.push(source), handle,
    });

    expect(JSON.parse(output.join(""))).toEqual({ receipt: { id: "message-1" } });
    expect(notices).toEqual(["identity refreshed\n"]);
  });

  it("refuses unknown tools and non-object arguments before contacting the backend", async () => {
    const session = sessionFixture();
    installReceipt(session.home, "claude");
    const options = { environment: session.environment, homeDirectory: session.home,
      workspaceRoot: session.workspace, output: () => {} };
    await expect(runOrchestrationToolFromCli({ ...options, arguments_: ["interaction.get", "{}"] }))
      .rejects.toMatchObject({ code: "orchestration_tool_unknown", message: expect.stringContaining("orchestration_events_read") });
    await expect(runOrchestrationToolFromCli({ ...options, arguments_: ["orchestration_events_read", "[]"] }))
      .rejects.toMatchObject({ code: "orchestration_tool_arguments_invalid" });
    await expect(runOrchestrationToolFromCli({ ...options, arguments_: [] }))
      .rejects.toMatchObject({ code: "orchestration_usage_invalid" });
  });

  it("selects the receipt of the provider this shell runs under, nearest scope first", () => {
    const session = sessionFixture();
    const globalClaude = installReceipt(session.home, "claude");
    const globalCodex = installReceipt(session.home, "codex");
    const resolve = (provider, environment = {}) => resolveOrchestrationToolReceipt({
      provider, environment, homeDirectory: session.home, workspaceRoot: session.workspace,
    });

    expect(resolve(undefined, { CLAUDECODE: "1" })).toEqual({ provider: "claude", receiptPath: globalClaude });
    expect(resolve("codex")).toEqual({ provider: "codex", receiptPath: globalCodex });
    expect(() => resolve(undefined)).toThrow(expect.objectContaining({ code: "orchestration_tool_provider_ambiguous" }));
    expect(() => resolve("gemini")).toThrow(expect.objectContaining({ code: "orchestration_tool_provider_invalid" }));

    const workspaceClaude = installReceipt(session.workspace, "claude");
    expect(resolve("claude")).toEqual({ provider: "claude", receiptPath: workspaceClaude });
    fs.rmSync(globalCodex);
    expect(resolve(undefined)).toEqual({ provider: "claude", receiptPath: workspaceClaude });
  });
});

describe("dure orchestration invoke with an MCP tool name", () => {
  it("names the tool command and the equivalent method without contacting the backend", async () => {
    const request = vi.fn();
    const prepareBackendProfile = vi.fn();
    await expect(runOrchestrationInvokeFromCli({
      arguments_: ["orchestration_interaction_get", "{}"], environment: {}, output: () => {},
      request, prepareBackendProfile,
    })).rejects.toMatchObject({
      code: "orchestration_method_unsupported",
      message: expect.stringMatching(
        /dure orchestration tool orchestration_interaction_get .*dure orchestration invoke interaction\.get /u),
    });
    await expect(runOrchestrationInvokeFromCli({
      arguments_: ["orchestration_events_read", "{}"], environment: {}, output: () => {}, request,
    })).rejects.toMatchObject({
      message: expect.stringMatching(/dure orchestration tool orchestration_events_read '<arguments-json>'$/u),
    });
    expect(request).not.toHaveBeenCalled();
    expect(prepareBackendProfile).not.toHaveBeenCalled();
  });

  it("reports the hint from the CLI and exits 2", () => {
    const root = fixtureRoot();
    const result = spawnSync(process.execPath, [
      cliPath, "orchestration", "invoke", "orchestration_interaction_get", "{}", "--json",
    ], { encoding: "utf8", env: { ...process.env, DURE_APP_CHANNEL: "stable", DURE_HOME: root, HOME: root } });

    expect(result.status).toBe(2);
    const { error } = JSON.parse(result.stderr);
    expect(error.code).toBe("orchestration_method_unsupported");
    expect(error.message).toContain("dure orchestration tool orchestration_interaction_get");
  });

  it("routes the tool subcommand through the CLI and reports a missing integration", () => {
    const root = fixtureRoot();
    const result = spawnSync(process.execPath, [
      cliPath, "orchestration", "tool", "orchestration_context_get_current", "--provider", "codex", "--json",
    ], { cwd: root, encoding: "utf8", env: { ...process.env, DURE_APP_CHANNEL: "stable", DURE_HOME: root, HOME: root } });

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe("orchestration_integration_missing");
  });
});
