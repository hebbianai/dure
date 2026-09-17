import { describe, expect, it, vi } from "vitest";
import { parseGoalCommand, runGoalCommand } from "../cli/lib/goal-command.mjs";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";

const body = {
  schemaVersion: 1,
  agentId: "agent-1",
  expectedRevision: 3,
  idempotencyKey: "goal-change-1",
  objective: "Finish the agreed report",
  status: "active",
  detail: null,
};
const args = [
  "put",
  body.agentId,
  "--objective",
  body.objective,
  "--status",
  body.status,
  "--expected-revision",
  "3",
  "--request-id",
  body.idempotencyKey,
  "--backend",
  "team",
];

describe("explicit goal commands", () => {
  it("sends the chosen revision and objective to the selected backend once", async () => {
    const profile = { id: "team" };
    const transportOptions = { maxResponseBytes: 1024 };
    const resolveBackend = vi.fn(async () => ({ profile, transportOptions }));
    const requestBackend = vi.fn(async () => ({
      result: { goal: { ...body, revision: 4 } },
    }));
    const output = vi.fn();
    expect(
      await runGoalCommand(args, { resolveBackend, requestBackend, output }),
    ).toBe(true);
    expect(resolveBackend).toHaveBeenCalledWith({
      backend: "team",
      backendSpecified: true,
    });
    expect(requestBackend).toHaveBeenCalledExactlyOnceWith(
      profile,
      {
        operation: "agent_goal.put",
        body,
        requiredCapabilities: ["agent_goal.v1"],
      },
      transportOptions,
    );
    expect(JSON.parse(output.mock.calls[0][0]).goal.revision).toBe(4);
  });

  it("reads through the same backend without preparing a mutation", async () => {
    const requestBackend = vi.fn(async () => ({ result: { goal: null } }));
    const output = vi.fn();
    expect(
      await runGoalCommand(["show", "agent-1"], {
        resolveBackend: async () => ({ profile: { id: "local" } }),
        requestBackend,
        output,
      }),
    ).toBe(true);
    expect(requestBackend).toHaveBeenCalledExactlyOnceWith(
      { id: "local" },
      {
        operation: "agent_goal.get",
        body: { schemaVersion: 1, agentId: "agent-1" },
        requiredCapabilities: ["agent_goal.v1"],
      },
      undefined,
    );
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({ goal: null });
  });

  it.each(["", "-1", "1.5", "Infinity", "9007199254740992"])(
    "does not turn malformed revision %j into a new-goal request",
    (revision) => {
      const malformed = [...args];
      malformed[7] = revision;
      expect(() => parseGoalCommand(malformed)).toThrow();
    },
  );

  it("returns an actual failure and the request ID without retrying", async () => {
    const requestBackend = vi.fn(async () => {
      throw new BackendTransportError("backend_transport_remote_error", {
        details: { code: "agent_goal_conflict", disposition: "terminal" },
      });
    });
    const output = vi.fn();
    expect(
      await runGoalCommand(args, {
        resolveBackend: async () => ({ profile: { id: "team" } }),
        requestBackend,
        output,
      }),
    ).toBe(false);
    expect(requestBackend).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
      requestId: body.idempotencyKey,
      error: { remoteCode: "agent_goal_conflict" },
    });
  });

  it.each(["get", "put"])(
    "forwards MCP goal %s through the common backend without opening a next-work decision",
    async (action) => {
      const requestBody =
        action === "put" ? body : { schemaVersion: 1, agentId: body.agentId };
      const receipt = {
        apiVersion: "dure.orchestration/v1",
        method: `agent_goal.${action}`,
        receipt: { schemaVersion: 1, goal: { ...body, revision: 4 } },
      };
      const request = vi.fn(async () => receipt);
      const response = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: `agent_goal_${action}`,
            arguments: { body: requestBody },
          },
        },
        { DURE_BACKEND_PROFILE: "team" },
        { request },
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toBe("backend-profile:team");
      expect(request.mock.calls[0][1]).toMatchObject({
        method: `agent_goal.${action}`,
        body: requestBody,
      });
      expect(response.structuredContent).toEqual(receipt);
    },
  );
});
