import { describe, expect, it, vi } from "vitest";
import { collectAgentRun, resolveAgentRunInteractionPreference } from "../cli/lib/agent-run.mjs";
import { canonicalNativeReceipt, request, succeededNativeReceipt } from "./fixtures/agent-spawn-receipts.mjs";

const descriptor = { port: 1234, token: "fixture-only", capabilities: ["agent.launch_preference_v1"] };

function fixture(clientDescriptor, interactionPreference = "native_cli") {
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
    interactionPreference: await resolveAgentRunInteractionPreference(clientDescriptor, requestClient), requestBackend,
  });
  return { run, requestClient, requestBackend };
}

describe("Agent Run pane preference", () => {
  it.each([undefined, { ...descriptor, capabilities: [] }])("defaults headless and older clients to Terminal (%j)", async (clientDescriptor) => {
    const test = fixture(clientDescriptor);
    expect((await test.run()).report.receipt.state).toBe("succeeded");
    expect(test.requestBackend.mock.calls[0][1].body.interactionPreference).toBe("native_cli");
    expect(test.requestClient).not.toHaveBeenCalled();
  });

  it.each(["native_cli", null])("carries the client's effective preference into the one preview (%s)", async (preference) => {
    const test = fixture(descriptor, preference);
    expect((await test.run()).report.receipt.state).toBe("succeeded");
    expect(test.requestClient).toHaveBeenCalledOnce();
    expect(test.requestClient).toHaveBeenCalledWith(expect.objectContaining({ descriptor, path: "/agent/launch-preference" }));
    expect(test.requestBackend.mock.calls[0][1].body.interactionPreference).toBe(preference ?? undefined);
  });

  it("does not create a runtime after a malformed preference reply", async () => {
    const test = fixture(descriptor, "future-profile");
    await expect(test.run()).rejects.toMatchObject({ code: "client_response_invalid" });
    expect(test.requestBackend).not.toHaveBeenCalled();
  });

  it("preserves other programmatic Run consumers' own launch policy", async () => {
    const test = fixture(undefined);
    await collectAgentRun({ ...request(), prompt: "never serialize this prompt", backend: { profile: { id: "local", transport: { kind: "local" } } }, requestBackend: test.requestBackend });
    expect(test.requestBackend.mock.calls[0][1].body).not.toHaveProperty("interactionPreference");
  });
});
