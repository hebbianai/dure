import { describe, expect, it, vi } from "vitest";
import {
  agentRunExitCode, collectAgentRun, resolveAgentRunInteractionPreference, resolveAgentRunInterface,
} from "../cli/lib/agent-run.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import {
  canonicalNativeReceipt, receipt, request, succeededNativeReceipt, succeededStructuredReceipt,
} from "./fixtures/agent-spawn-receipts.mjs";

const descriptor = { port: 1234, token: "fixture-only", capabilities: ["agent.launch_preference_v1"] };
const adoptingDescriptor = { ...descriptor, capabilities: ["agent.run_background_v1"] };
const localProfile = { id: "local", transport: { kind: "local" } };
const sshProfile = { id: "vm", transport: { kind: "ssh" } };

function fixture(client, interactionPreference = "native_cli") {
  const requestClient = vi.fn(async () => ({ ok: true, schemaVersion: 1, interactionPreference }));
  let preview;
  const requestBackend = vi.fn(async (_profile, envelope) => {
    if (envelope.operation === "agent_spawn.preview") preview = canonicalNativeReceipt(envelope.body);
    const completed = succeededNativeReceipt();
    completed.plan = preview.plan;
    return {
      backend: { id: "fixture", generation: "fixture-1", protocol: { major: 1, minor: 0 }, capabilities: ["agent_spawn.preview.v2", "agent_spawn.apply"], observedAtMs: Date.now() },
      result: { schemaVersion: 1, receipt: envelope.operation === "agent_spawn.preview" ? preview : completed },
    };
  });
  const run = async () => collectAgentRun({
    ...request(), prompt: "never serialize this prompt",
    backend: { profile: { id: "local", transport: { kind: "local" } } },
    interactionPreference: await resolveAgentRunInteractionPreference({ presenting: true, profile: localProfile, ...client }, requestClient), requestBackend,
  });
  return { run, requestClient, requestBackend };
}

describe("Agent Run pane preference", () => {
  it.each([
    { descriptor: null, presenting: false },
    { descriptor: null, presenting: true },
    { descriptor: undefined, presenting: false },
  ])("lets the backend choose the runtime when no app can supply a preference (%j)", async (client) => {
    const test = fixture(client);
    expect((await test.run()).report.receipt.state).toBe("succeeded");
    expect(test.requestBackend.mock.calls[0][1].body).not.toHaveProperty("interactionPreference");
    expect(test.requestClient).not.toHaveBeenCalled();
  });

  it("keeps a pane on Terminal for an app too old to state a preference", async () => {
    const test = fixture({ descriptor: { ...descriptor, capabilities: [] } });
    await test.run();
    expect(test.requestBackend.mock.calls[0][1].body.interactionPreference).toBe("native_cli");
    expect(test.requestClient).not.toHaveBeenCalled();
  });

  it("keeps a headless Run on Terminal when the local app adopts it", async () => {
    const test = fixture({ descriptor: adoptingDescriptor, presenting: false });
    await test.run();
    expect(test.requestBackend.mock.calls[0][1].body.interactionPreference).toBe("native_cli");
    expect(test.requestClient).not.toHaveBeenCalled();
  });

  it.each([
    ["a remote backend", { descriptor: adoptingDescriptor, presenting: false, profile: sshProfile }],
    ["an app that cannot adopt Runs", { descriptor, presenting: false }],
  ])("does not pin a headless Run for %s", async (_label, client) => {
    const test = fixture(client);
    await test.run();
    expect(test.requestBackend.mock.calls[0][1].body).not.toHaveProperty("interactionPreference");
    expect(test.requestClient).not.toHaveBeenCalled();
  });

  it.each(["native_cli", null])("carries the client's effective preference into the one preview (%s)", async (preference) => {
    const test = fixture({ descriptor }, preference);
    expect((await test.run()).report.receipt.state).toBe("succeeded");
    expect(test.requestClient).toHaveBeenCalledOnce();
    expect(test.requestClient).toHaveBeenCalledWith(expect.objectContaining({ descriptor, path: "/agent/launch-preference" }));
    expect(test.requestBackend.mock.calls[0][1].body.interactionPreference).toBe(preference ?? undefined);
  });

  it("does not create a runtime after a malformed preference reply", async () => {
    const test = fixture({ descriptor }, "future-profile");
    await expect(test.run()).rejects.toMatchObject({ code: "client_response_invalid" });
    expect(test.requestBackend).not.toHaveBeenCalled();
  });

  it("preserves other programmatic Run consumers' own launch policy", async () => {
    const test = fixture({ descriptor: null });
    await collectAgentRun({ ...request(), prompt: "never serialize this prompt", backend: { profile: { id: "local", transport: { kind: "local" } } }, requestBackend: test.requestBackend });
    expect(test.requestBackend.mock.calls[0][1].body).not.toHaveProperty("interactionPreference");
  });
});

describe("Agent Run interface selection", () => {
  const terminalRefusal = () => new BackendTransportError("backend_transport_remote_error", {
    details: {
      code: "agent_spawn_provider_preflight_failed",
      reasonCode: "provider_runtime_integration_unavailable",
      disposition: "retry_same",
    },
  });

  function structuredPreview(body) {
    const value = receipt(body);
    delete value.plan.sessionId;
    delete value.plan.runtime;
    value.plan.launch = { interactionProfile: "structured_protocol" };
    value.plan.request.executionProfile = { kind: "provider_default" };
    return value;
  }

  /** A backend whose host has no terminal integration but runs chat, like an SSH host without the app. */
  function chatOnlyBackend({ chat = true } = {}) {
    let preview;
    let previewBody;
    return vi.fn(async (_profile, envelope) => {
      if (envelope.operation === "agent_spawn.preview") {
        if (envelope.body.interactionPreference === "native_cli") throw terminalRefusal();
        previewBody = envelope.body;
        preview = chat ? structuredPreview(previewBody) : canonicalNativeReceipt(previewBody);
      }
      const completed = chat ? succeededStructuredReceipt(previewBody) : succeededNativeReceipt();
      completed.plan = preview.plan;
      return {
        backend: { id: "fixture", generation: "fixture-1", protocol: { major: 1, minor: 0 }, capabilities: ["agent_spawn.preview.v2", "agent_spawn.apply"], observedAtMs: Date.now() },
        result: { schemaVersion: 1, receipt: envelope.operation === "agent_spawn.preview" ? preview : completed },
      };
    });
  }

  async function run(client, requestBackend, extra = {}) {
    const requestClient = vi.fn(async () => ({ ok: true, schemaVersion: 1, interactionPreference: "native_cli" }));
    const selected = await resolveAgentRunInterface({ profile: sshProfile, ...client }, requestClient);
    const result = await collectAgentRun({
      ...request({ providerId: "claude", agentName: "claude-1" }), prompt: "never serialize this prompt",
      backend: { profile: sshProfile }, ...selected, ...extra, requestBackend,
    });
    return { ...result, requestClient, previews: requestBackend.mock.calls.filter(([, envelope]) => envelope.operation === "agent_spawn.preview") };
  }

  it("starts a pane's Terminal default in chat when the host has no terminal integration", async () => {
    const requestBackend = chatOnlyBackend();
    const result = await run({ descriptor, presenting: true }, requestBackend);
    expect(result.report.receipt.state).toBe("succeeded");
    expect(result.report.receipt.plan.launch.interactionProfile).toBe("structured_protocol");
    expect(result.interactionFallback).toEqual({
      from: "native_cli", to: "structured_protocol", reasonCode: "provider_runtime_integration_unavailable",
    });
    expect(result.previews).toHaveLength(2);
    expect(result.previews[0][1].body.interactionPreference).toBe("native_cli");
    expect(result.previews[1][1].body).not.toHaveProperty("interactionPreference");
    expect(result.previews[1][1].body.idempotencyKey).toBe(result.previews[0][1].body.idempotencyKey);
  });

  it("gives the same Run headless and inside a pane", async () => {
    const headless = await run({ descriptor, presenting: false }, chatOnlyBackend());
    const pane = await run({ descriptor, presenting: true }, chatOnlyBackend());
    expect(pane.report.receipt.plan.launch).toEqual(headless.report.receipt.plan.launch);
  });

  it("keeps --runtime terminal on the terminal and says how to choose chat", async () => {
    const requestBackend = chatOnlyBackend();
    const result = await run({ runtime: "terminal", descriptor, presenting: false }, requestBackend);
    expect(result.requestClient).not.toHaveBeenCalled();
    expect(result.previews).toHaveLength(1);
    expect(result.previews[0][1].body.interactionPreference).toBe("native_cli");
    expect(result.interactionFallback).toBeUndefined();
    expect(result.report.error).toMatchObject({ reasonCode: "provider_runtime_integration_unavailable" });
    expect(result.report.error.message).toContain("run it with --runtime chat");
    expect(agentRunExitCode(result.report)).toBe(2);
  });

  it("starts --runtime chat in chat inside a pane without consulting the Terminal preference", async () => {
    const requestBackend = chatOnlyBackend();
    const result = await run({ runtime: "chat", descriptor, presenting: true }, requestBackend);
    expect(result.requestClient).not.toHaveBeenCalled();
    expect(result.previews).toHaveLength(1);
    expect(result.previews[0][1].body).not.toHaveProperty("interactionPreference");
    expect(result.report.receipt.state).toBe("succeeded");
    expect(result.interactionFallback).toBeUndefined();
  });

  it("refuses --runtime chat before apply when the host plans a terminal session", async () => {
    const requestBackend = chatOnlyBackend({ chat: false });
    const result = await run({ runtime: "chat", descriptor: null, presenting: false }, requestBackend);
    expect(result.report.error).toMatchObject({ code: "agent_run_chat_runtime_unavailable", profileId: "vm" });
    expect(result.report.error.message).toContain("--runtime terminal");
    expect(agentRunExitCode(result.report)).toBe(2);
    expect(requestBackend.mock.calls.map(([, envelope]) => envelope.operation)).toEqual(["agent_spawn.preview"]);
  });

  it.each([
    ["an app too old to show a chat pane", { descriptor: { ...descriptor, capabilities: [] }, presenting: true }, {}],
    ["a setup command, which needs a terminal", { descriptor, presenting: true }, { setupCommand: "pnpm install" }],
  ])("does not fall back to chat for %s", async (_label, client, extra) => {
    const requestBackend = chatOnlyBackend();
    const result = await run(client, requestBackend, extra);
    expect(result.previews).toHaveLength(1);
    expect(result.interactionFallback).toBeUndefined();
    expect(result.report.error).toMatchObject({ reasonCode: "provider_runtime_integration_unavailable" });
  });
});
