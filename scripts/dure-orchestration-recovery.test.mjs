import { expect, it, vi } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";

const environment = {
  DURE_BACKEND_PROFILE: "local",
  HMUX_SESSION_ID: "resumed-session", HMUX_WORKSPACE_ID: "workspace",
  HMUX_RUNNER_PRINCIPAL: "runner", HMUX_RUNNER_INSTANCE: "instance",
  HMUX_CHANNEL_EPOCH: "2", HMUX_HOST_INSTANCE_ID: "host", HMUX_TERMINAL_EPOCH: "terminal",
};
const integrationReceipt = {
  schemaVersion: 1, provider: "codex", version: "fixture-v1", digest: "a".repeat(64),
  channel: "test", capabilities: ["event_cursor_v1"],
};

it.each([
  ["hmux_descriptor_timeout", /Retry the same context lookup/],
  ["hmux_descriptor_unavailable", /Retry the same context lookup/],
  ["hmux_runtime_identity_changed", /Restart the Dure app/],
  ["hmux_descriptor_malformed", /dure diagnostics --json/],
])("guides current-context recovery for %s without enrolling another Run", async (reasonCode, guidance) => {
  const failure = new BackendTransportError("backend_transport_remote_error", {
    details: { code: "orchestration_session_unavailable", reasonCode, disposition: "retry_same" },
  });
  const request = vi.fn(async (_endpoint, operation) => {
    expect(operation.method).toBe("dispatch.context.get");
    throw failure;
  });
  await expect(handleMcpRequest({ jsonrpc: "2.0", method: "tools/call",
    params: { name: "orchestration_context_get_current", arguments: {} },
  }, environment, { request, integrationReceipt })).rejects.toMatchObject({
    message: expect.stringMatching(guidance), cause: failure,
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["stale_generation", "terminal"])(
  "tells a process whose Session generation exited to stop instead of retrying (%s)",
  async (disposition) => {
    const failure = new BackendTransportError("backend_transport_remote_error", {
      details: { code: "orchestration_generation_conflict", reasonCode: "hmux_session_exited", disposition },
    });
    const request = vi.fn(async () => { throw failure; });
    const call = handleMcpRequest({ jsonrpc: "2.0", method: "tools/call",
      params: { name: "orchestration_events_read", arguments: { limit: 40 } },
    }, environment, { request, integrationReceipt });
    await expect(call).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(
        `^orchestration_generation_conflict: hmux_session_exited \\(${disposition}\\): ` +
        "This managed Session generation has exited.*dure runs show <agent>.*cannot succeed\\.$")),
      cause: failure,
    });
    await expect(call).rejects.not.toMatchObject({ message: expect.stringMatching(/Retry the same/) });
    // A retired generation is never enrolled as a new Run.
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each(["orchestration_context_get_current", "orchestration_events_read"])(
  "explains a live Session that no Agent binds instead of asking to retry (%s)",
  async (tool) => {
    const unassigned = new BackendTransportError("backend_transport_remote_error", {
      details: { code: "orchestration_generation_conflict", disposition: "unassigned" },
    });
    const unbound = new BackendTransportError("backend_transport_remote_error", {
      details: {
        code: "orchestration_generation_conflict",
        reasonCode: "session_agent_binding_missing",
        disposition: "stale_generation",
      },
    });
    const request = vi.fn(async (_endpoint, operation) => {
      throw operation.method === "dispatch.context.get" ? unassigned : unbound;
    });
    // Enrollment needs a receipt that can carry durable delivery.
    const enrollableReceipt = {
      ...integrationReceipt,
      capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
    };
    const call = handleMcpRequest({ jsonrpc: "2.0", method: "tools/call",
      params: { name: tool, arguments: {} },
    }, environment, { request, integrationReceipt: enrollableReceipt });
    await expect(call).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(
        "^orchestration_generation_conflict: session_agent_binding_missing \\(stale_generation\\): " +
        "This managed Session is live, but no Dure Agent binds it.*dure runs resume <agent>" +
        ".*dure runs show <agent>.*cannot succeed until that binding changes")),
      cause: unbound,
    });
    await expect(call).rejects.not.toMatchObject({ message: expect.stringMatching(/backend rejected/) });
    // One context lookup and one enrollment; nothing else is created or read.
    expect(request.mock.calls.map(([, operation]) => operation.method))
      .toEqual(["dispatch.context.get", "run.create"]);
  },
);

it.each(["orchestration_context_get_current", "orchestration_events_read"])(
  "tells an agent on its Chat runtime to report in the conversation instead of retrying (%s)",
  async (tool) => {
    const unassigned = new BackendTransportError("backend_transport_remote_error", {
      details: { code: "orchestration_generation_conflict", disposition: "unassigned" },
    });
    const chat = new BackendTransportError("backend_transport_remote_error", {
      details: {
        code: "orchestration_interaction_profile_unsupported",
        reasonCode: "structured_protocol",
        disposition: "terminal",
      },
    });
    const request = vi.fn(async (_endpoint, operation) => {
      throw operation.method === "dispatch.context.get" ? unassigned : chat;
    });
    const enrollableReceipt = {
      ...integrationReceipt,
      capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
    };
    const call = handleMcpRequest({ jsonrpc: "2.0", method: "tools/call",
      params: { name: tool, arguments: {} },
    }, environment, { request, integrationReceipt: enrollableReceipt });
    await expect(call).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(
        "^orchestration_interaction_profile_unsupported: structured_protocol \\(terminal\\): " +
        "This agent runs on its Chat runtime.*report your result in this conversation.*" +
        "create another Run; retrying cannot succeed\\.$")),
      cause: chat,
    });
    await expect(call).rejects.not.toMatchObject({ message: expect.stringMatching(/dure runs resume/) });
    expect(request.mock.calls.map(([, operation]) => operation.method))
      .toEqual(["dispatch.context.get", "run.create"]);
  },
);

it("explains a destination Session without an inbox instead of a bare generation conflict", async () => {
  const failure = new BackendTransportError("backend_transport_remote_error", {
    details: { code: "orchestration_generation_conflict", reasonCode: "session_dispatch_unassigned", disposition: "terminal" },
  });
  const request = vi.fn(async () => { throw failure; });
  await expect(handleMcpRequest({ jsonrpc: "2.0", method: "tools/call",
    params: { name: "orchestration_message_open_exact_session", arguments: { body: {} } },
  }, environment, { request })).rejects.toMatchObject({
    message: expect.stringMatching(new RegExp(
      "^orchestration_generation_conflict: session_dispatch_unassigned \\(terminal\\): " +
      "This managed Session is live, but no Dispatch binds its current generation.*" +
      "orchestration_context_get_current.*dure runs resume <agent>.*without --track.*cannot succeed")),
    cause: failure,
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("corrects an older backend's invalid-request retry guidance without exposing its payload", async () => {
  const failure = new BackendTransportError("backend_transport_remote_error", {
    details: { code: "orchestration_request_invalid", disposition: "retry_same",
      message: "private-report", field: "private-capability-as-field" },
  });
  const request = vi.fn(async () => { throw failure; });
  await expect(handleMcpRequest({ jsonrpc: "2.0", method: "tools/call",
    params: { name: "orchestration_interaction_get", arguments: { body: {} } },
  }, environment, { request })).rejects.toMatchObject({
    message: expect.stringMatching(/^orchestration_request_invalid \(terminal\): .*Correct it using the tool's input schema/),
    cause: failure,
  });
  expect(request).toHaveBeenCalledTimes(1);
});
