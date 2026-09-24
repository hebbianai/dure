import { describe, expect, it, vi } from "vitest";
import {
  managedRunPresentationRequest,
  presentAgentRunRuntime,
  registerAgentRunInBackground,
  structuredRunPresentationRequest,
} from "../cli/lib/run-presentation.mjs";
import {
  adoptExistingCheckout,
  succeededNativeReceipt,
  succeededStructuredReceipt,
} from "./fixtures/agent-spawn-receipts.mjs";

describe.each([
  ["native", succeededNativeReceipt, managedRunPresentationRequest],
  ["structured", succeededStructuredReceipt, structuredRunPresentationRequest],
])("%s Run destination projection", (_name, makeReceipt, project) => {
  const options = (receipt) => ({
    report: { kind: "dure.agent_spawn.apply", receipt },
    target: { state: "requested", spaceId: "space-a", windowLabel: "main" },
    profile: { id: "local", transport: { kind: "local" } },
    projectPath: "/repo",
  });

  function presentation(receipt, changes = {}) {
    const input = options(receipt);
    const expected = project(input);
    const pane = {
      spaceId: expected.spaceId,
      panelId: `agent:${expected.agentId}`,
      agentId: expected.agentId,
      outcome: "created",
      ...(_name === "native"
        ? {
            runtime: expected.runtime,
            sessionId: expected.sessionId,
            workspaceId: expected.workspaceId,
          }
        : {
            interactionProfile: expected.interactionProfile,
            interactionSessionId: expected.interactionSessionId,
          }),
      ...changes,
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, pane }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    return {
      pane,
      fetchImpl,
      run: () =>
        presentAgentRunRuntime({
          ...input,
          descriptor: {
            port: 42,
            token: "fixture-token",
            channel: "stable",
            generation: "fixture-generation",
            buildId: "0.2.16+fixture",
          },
          fetchImpl,
        }),
    };
  }

  it.each(["slot", "pane-neutral", "launcher:previous", "term:previous", "agent:previous"])(
    "reports the client's actual pane %s without deriving its ID from the Agent",
    async (panelId) => {
      for (const outcome of ["created", "reused"]) {
        const fixture = presentation(makeReceipt(), { panelId, outcome });
        await expect(fixture.run()).resolves.toMatchObject({
          state: "opened",
          pane: fixture.pane,
        });
        expect(fixture.fetchImpl).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    "spaceId",
    "agentId",
    ...(_name === "native"
      ? ["sessionId", "workspaceId"]
      : ["interactionSessionId"]),
  ])(
    "does not accept a different %s behind a plausible pane ID",
    async (field) => {
      const fixture = presentation(makeReceipt(), { [field]: "wrong-target" });
      await expect(fixture.run()).rejects.toMatchObject({ code: "client_response_invalid" });
      expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("sends the backend's actual checkout root to the client", () => {
    const receipt = makeReceipt();
    receipt.plan.request.worktree.checkout_path = "/selected/work/codex-1";
    receipt.plan.request.worktree.branch_mode = "existing";
    receipt.checkoutRegistration = {
      repositoryPath: "/repo",
      instance: {
        schemaVersion: 1,
        canonicalPath: "/canonical/work/codex-1",
        gitCommonDir: "/repo/.git",
        gitDir: "/repo/.git/worktrees/codex-1",
        instanceToken: `dwt1_${"a".repeat(32)}`,
      },
    };
    const outgoing = project(options(receipt));
    const expected = {
      kind: "dedicated",
      branch: "agent/codex-1",
      directoryName: "codex-1",
      rootPath: "/canonical/work/codex-1",
    };
    expect(outgoing.worktree).toEqual(expected);
  });

  it("keeps legacy default receipts usable without inventing a root", () => {
    expect(project(options(makeReceipt())).worktree).toEqual({
      kind: "dedicated",
      branch: "agent/codex-1",
      directoryName: "codex-1",
    });
  });

  it("presents a selected checkout without a source Agent or a derived directory", () => {
    const value = adoptExistingCheckout(makeReceipt());
    expect(project(options(value)).worktree).toEqual({
      kind: "existing_checkout", branch: "user/work", rootPath: "/repo/preexisting-checkout",
    });
    value.checkoutRegistration = { ...value.checkoutRegistration,
      instance: { ...value.checkoutRegistration.instance, instanceToken: `dwt1_${"b".repeat(32)}` } };
    expect(() => project(options(value))).toThrowError(
      expect.objectContaining({ code: "client_run_receipt_invalid" }),
    );
  });

  it("does not apply new-branch naming limits to an already selected checkout", () => {
    const value = adoptExistingCheckout(makeReceipt());
    const branch = `${"a".repeat(128)}/${"b".repeat(128)}`;
    value.plan.request.worktree.branch = branch;
    expect(project(options(value)).worktree).toEqual({
      kind: "existing_checkout", branch, rootPath: "/repo/preexisting-checkout",
    });
  });

  it("does not substitute the default location for a missing explicit result", () => {
    const receipt = makeReceipt();
    receipt.plan.request.worktree.checkout_path = "/selected/work/codex-1";
    expect(() => project(options(receipt))).toThrowError(
      expect.objectContaining({ code: "client_run_receipt_invalid" }),
    );
  });
});

it("registers a background structured Run without requesting a pane or Space", async () => {
  const receipt = succeededStructuredReceipt();
  const fetchImpl = vi.fn(async (_url, request) => {
    const body = JSON.parse(request.body);
    expect(body.presentation).toBe("background");
    expect(body.spaceId).toBeUndefined();
    return new Response(JSON.stringify({
      ok: true,
      agent: { agentId: body.agentId, interactionSessionId: body.interactionSessionId },
    }));
  });
  await expect(presentAgentRunRuntime({
    report: { kind: "dure.agent_spawn.apply", receipt },
    target: { state: "background", windowLabel: "main" },
    profile: { id: "local", transport: { kind: "local" } },
    projectPath: "/repo",
    descriptor: { port: 42, token: "fixture", channel: "stable", generation: "fixture", buildId: "fixture" },
    fetchImpl,
  })).resolves.toMatchObject({ state: "background", agent: { agentId: receipt.plan.agentId } });
  expect(fetchImpl).toHaveBeenCalledOnce();
});


describe("native Run background registration", () => {
  it("registers one exact runtime without selecting a Space or opening a pane", async () => {
    const receipt = succeededNativeReceipt();
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body).not.toHaveProperty("spaceId");
      expect(body).not.toHaveProperty("windowLabel");
      return new Response(JSON.stringify({ok:true,agent:{agentId:body.agentId,sessionId:body.sessionId}}));
    });
    const result = await registerAgentRunInBackground({report:{kind:"dure.agent_spawn.apply",receipt},
      profile:{id:"local",transport:{kind:"local"}},projectPath:"/repo",
      descriptor:{port:42,token:"fixture",capabilities:["agent.run_background_v1"]},fetchImpl});
    expect(result).toMatchObject({state:"registered",agentId:receipt.plan.agentId});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("keeps headless no-client and remote launches independent of local registration", async () => {
    const fetchImpl=vi.fn();
    expect(await registerAgentRunInBackground({profile:{transport:{kind:"ssh"}},descriptor:{capabilities:["agent.run_background_v1"]},fetchImpl})).toBeUndefined();
    expect(await registerAgentRunInBackground({profile:{transport:{kind:"local"}},fetchImpl})).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
