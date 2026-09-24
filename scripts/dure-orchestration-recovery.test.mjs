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
